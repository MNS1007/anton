// One phone call on GPT-Live, OpenAI's full-duplex voice model.
// GPT-Live listens while it speaks and decides by itself when to stop, pause or
// carry on, so there is no turn detection and no cut-off code here. Its audio
// arrives at the pace it plays, so a transport never holds a backlog to drop.
//
// Three parts, kept apart:
// - transport: moves call audio. The Twilio media stream below, or nothing at all
//   when the call reaches OpenAI over SIP (src/sip.js).
// - engine (liveCall): one GPT-Live session. Tools run through a backend model
//   ("Responses delegation"); Claude's updates are handed over as commentary.
// - tools (src/tools.js): the same tools and guardrail the Realtime engine uses.
import WebSocket from 'ws'
import { config } from './config.js'
import { log } from './log.js'
import * as caller from './caller.js'
import * as memory from './memory.js'
import { TOOLS, instructions, callTools } from './tools.js'

const user = config.userName
const wsUrl = path => config.liveUrl.replace(/^http/, 'ws') + path

// The session settings, for session.start or for accepting a SIP call.
export function sessionConfig(updates, { sip = false } = {}) {
  const prompt = instructions(updates)
  return {
    ...(sip ? { type: 'live' } : {}),
    model: config.liveModel,
    instructions: `${prompt}

You talk; a backend does the work, and it is slow (often 10 to 30 seconds). So:
- Answer yourself whenever you can from what was already said on this call or what you already know: explaining a term, repeating or rephrasing something, opinions, simple yes or no. Do not say "checking" for those.
- Use the backend only to act (send a task, answer a permission, post, remember, hang up) or to fetch something new (status, an agent's work, porch). Say one short line while it works, then keep listening.
- Let ${user} finish. If they trail off or a sentence is cut, wait a moment or ask for the missing part; do not answer half a question.
- Keep a list of every request ${user} makes on the call. When one is unclear, ask about that one, and if the talk moves on, come back to it before the call ends. Before saying goodbye, say which requests were sent and which still need something from ${user}.`,
    audio: {
      ...(sip ? {} : { format: { type: 'audio/pcmu', rate: 8000 } }),
      output: { voice: config.liveVoice },
    },
    delegation: {
      type: 'responses',
      responses: {
        model: config.liveBackendModel,
        instructions: `You are the backend for ${config.assistantName}, a phone assistant. Do what the call needs with your tools and answer in one or two short plain sentences that can be spoken. These are the assistant's rules:\n\n${prompt}`,
        tools: TOOLS,
        tool_choice: 'auto',
        parallel_tool_calls: false,
      },
    },
  }
}

// The engine. sendAudio plays GPT-Live's audio to the caller when there is a media stream;
// over SIP OpenAI has the audio and Anton only sees events.
export function liveCall({ callSid, sendAudio = null, hangUp = () => {}, makeTools = callTools, hangupDelayMs = 6000, summarize }) {
  let ws = null
  let ended = false
  let userSpoke = false
  let hangupPending = false
  let eventId = 0
  const talk = callSid ? memory.transcript(callSid) : null
  const tools = makeTools({ onHangup: () => { hangupPending = true } })
  const send = obj => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event_id: `anton_${++eventId}`, ...obj })) }

  // Transcripts come as deltas with no turn marker; a change of speaker ends a line.
  let speaker = null
  let line = ''
  const flush = () => { if (speaker && line.trim()) talk?.add(speaker, line.trim()); line = '' }
  const heard = (who, text) => { if (who !== speaker) { flush(); speaker = who } line += text }

  const bridge = {
    callSid,
    inject(text) {
      flush()
      talk?.add('update', text)
      tools.outside()
      send({ type: 'session.commentary.append', delegation_id: null, content: `[Update from Claude Code, not said by ${user}] ${clip(text, 1500)}\nTell ${user} the gist briefly.` })
    },
  }
  const updates = caller.callStarted(bridge)
  for (const u of updates) talk?.add('update', u)
  if (updates.length) tools.outside()

  async function onEvent(ev) {
    switch (ev.type) {
      case 'session.started':
        log(`live session ${ev.session?.id} started`)
        send({ type: 'session.commentary.append', delegation_id: null, content: 'Start the call now, as your instructions say. Then listen.' })
        break
      case 'session.output_audio.delta':
        if (sendAudio && ev.delta) sendAudio(ev.delta)
        break
      case 'session.input_transcript.delta':
        if (ev.delta?.trim()) { userSpoke = true; tools.userSpoke() }
        heard('user', ev.delta || '')
        break
      case 'session.output_transcript.delta':
        heard('anton', ev.delta || '')
        break
      case 'response.event': {
        const e = ev.event || {}
        if (e.type === 'response.output_item.done' && e.item?.type === 'function_call') await runCall(e.item)
        break
      }
      case 'error':
        log(`live: ${ev.error?.message || JSON.stringify(ev.error)}`)
        break
      case 'session.closed':
        end()
        break
    }
  }

  async function runCall(item) {
    let args = {}
    try { args = JSON.parse(item.arguments || '{}') } catch {}
    const output = await tools.run(item.name, args)
    flush()
    talk?.add('tool', `${item.name} ${clip(JSON.stringify(args), 200)}`)
    log(`tool ${item.name}`)
    send({ type: 'response.item.create', item: { type: 'function_call_output', call_id: item.call_id, output: JSON.stringify(output) } })
    send({ type: 'response.create' })
    if (hangupPending) setTimeout(() => hangUp(), hangupDelayMs)
  }

  function attach(socket, { start = true } = {}) {
    ws = socket
    const begin = () => { if (start) send({ type: 'session.start', session: sessionConfig(updates) }) }
    if (ws.readyState === WebSocket.OPEN) begin()
    else ws.on('open', begin)
    ws.on('message', raw => {
      let ev
      try { ev = JSON.parse(raw) } catch { return }
      onEvent(ev).catch(err => log(`live event ${ev.type}: ${err.message}`))
    })
    ws.on('error', err => log(`live socket: ${err.message}`))
    ws.on('close', () => end())
  }

  function end() {
    if (ended) return
    ended = true
    flush()
    log('call ended')
    send({ type: 'session.close' })
    setTimeout(() => { try { ws?.close() } catch {} }, 2000)
    caller.callEnded({ userSpoke, updates })
    if (talk) (summarize || memory.summarizeCall)(callSid, talk.lines()).catch(err => log(`could not remember the call: ${err.message}`))
  }

  return {
    bridge,
    updates,
    attach,
    end,
    audioIn(b64) { send({ type: 'session.input_audio.append', audio: b64 }) },
  }
}

// Transport: a Twilio media stream carrying 8 kHz mu-law both ways, unchanged.
export function handleLiveCall(twilioWs, { makeTools, summarize } = {}) {
  let streamSid = null
  let call = null
  const sendTwilio = obj => { if (twilioWs.readyState === WebSocket.OPEN) twilioWs.send(JSON.stringify(obj)) }

  twilioWs.on('message', raw => {
    let msg
    try { msg = JSON.parse(raw) } catch { return }
    switch (msg.event) {
      case 'start': {
        streamSid = msg.start.streamSid
        const callSid = msg.start.callSid
        log('call connected (GPT-Live)')
        call = liveCall({
          callSid,
          makeTools,
          summarize,
          sendAudio: delta => sendTwilio({ event: 'media', streamSid, media: { payload: delta } }),
          hangUp: () => caller.hangUp(callSid),
        })
        call.attach(new WebSocket(wsUrl(''), { headers: { Authorization: `Bearer ${config.openaiKey}` } }))
        break
      }
      case 'media':
        call?.audioIn(msg.media.payload)
        break
      case 'stop':
        call?.end()
        break
    }
  })
  twilioWs.on('close', () => call?.end())
}

function clip(s, n) {
  s = String(s || '')
  return s.length > n ? s.slice(0, n) + '...' : s
}
