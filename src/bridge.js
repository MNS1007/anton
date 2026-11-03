// One phone call: Twilio media stream <-> OpenAI Realtime, with tools that drive Claude.
import WebSocket from 'ws'
import { config } from './config.js'
import { log } from './log.js'
import * as caller from './caller.js'
import * as memory from './memory.js'
import { callTrace } from './trace.js'
import { TOOLS, instructions, callTools } from './tools.js'

const user = config.userName

// Talk-over handling. The server's own VAD both cut Anton off and started a reply on
// any sound, so line noise, an echo or a "yeah" made Anton stop and start over (the
// same greeting three times in 8 seconds). Now Anton decides:
// - Anton silent: the user's turn ends, Anton answers at once.
// - Anton talking, short sound: ignored. Steady speech for bargeInMs: Anton stops.
// - Anton talking, the sound ends before that: wait for its words. A backchannel or
//   Anton's own voice coming back is ignored; anything else is answered when Anton
//   finishes, without cutting it off.
// TURN_MODE=server puts back the old behaviour (the server cuts off and answers),
// for comparing on the bench or rolling back without a code change.
const serverTurns = () => config.turnMode === 'server'
export function turnSettings() {
  if (serverTurns()) return { format: { type: 'audio/pcmu' }, transcription: { model: config.transcribeModel }, turn_detection: { type: 'semantic_vad' } }
  return {
    format: { type: 'audio/pcmu' },
    transcription: { model: config.transcribeModel, ...(config.transcribeLanguage ? { language: config.transcribeLanguage } : {}) },
    noise_reduction: config.noiseReduction === 'off' ? null : { type: config.noiseReduction },
    turn_detection: { type: 'semantic_vad', eagerness: config.vadEagerness, create_response: false, interrupt_response: false },
  }
}

const FILLER = /^(yeah|yes|yep|yup|ok|okay|mm+|hm+|mm-?hm+|mhm|uh-?huh|uh|um|right|sure|cool|nice|ah|oh|got it|i see|alright|all right)$/i
const words = s => String(s || '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean)

// Nothing that needs an answer: empty, no English letters, or a backchannel.
export function isFiller(text) {
  const t = String(text || '').trim().replace(/[.!?,]+$/g, '')
  if (!/[a-z]/i.test(t)) return true
  return FILLER.test(t) || t.split(/[\s,.]+/).every(w => !w || FILLER.test(w))
}

// Anton's own voice heard back: most of the words are what Anton is saying now.
export function isEcho(text, spoken) {
  const heard = words(text)
  if (heard.length < 3) return false
  const said = new Set(words(spoken))
  return heard.filter(w => said.has(w)).length / heard.length >= 0.7
}

export function handleCall(twilioWs, { makeTools = callTools, summarize } = {}) {
  let streamSid = null
  let callSid = null
  let openai = null
  let updates = []
  let userSpoke = false
  let responseActive = false
  let responseQueued = false
  let hangupPending = false
  let ended = false
  let started = false
  let talk = null // this call's transcript, for memory
  let trace = null
  const mark = (ev, data) => trace?.add(ev, data)
  // for cutting off Anton when the user talks over it
  let latestMediaTs = 0
  let responseStartTs = null
  let lastAssistantItem = null
  // OpenAI sends audio faster than it plays, so Anton is still talking after
  // response.done. Twilio echoes each mark when the audio before it has played.
  let marksPending = 0
  let markGen = 0 // bumped on each cut-off; Twilio echoes the marks it drops, and those are ignored
  let itemSentMs = 0
  let bargeTimer = null
  let bargedIn = false
  let spoken = '' // what Anton is saying now, to recognise its echo
  const overlapped = new Set() // user items that started while Anton talked, waiting for their words
  // Guardrail: actions need the user to have spoken after the latest outside message.
  const tools = makeTools({ onHangup: () => { hangupPending = true } })
  const audible = () => responseActive || marksPending > 0

  const bridge = {
    callSid: null,
    inject(text) {
      talk?.add('update', text)
      mark('inject', { chars: String(text).length })
      tools.outside()
      sendAI({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: `[Update from Claude Code, not said by ${user}] ${text}\nTell ${user} the gist briefly.` }],
        },
      })
      requestResponse('inject')
    },
  }

  const sendAI = obj => { if (openai?.readyState === WebSocket.OPEN) openai.send(JSON.stringify(obj)) }
  const sendTwilio = obj => { if (twilioWs.readyState === WebSocket.OPEN) twilioWs.send(JSON.stringify(obj)) }

  function requestResponse(why) {
    if (responseActive) { responseQueued = true; mark('response.queued', { why }); return }
    responseActive = true
    mark('response.request', { why })
    sendAI({ type: 'response.create' })
  }

  function connectAI() {
    openai = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(config.realtimeModel)}`, {
      headers: { Authorization: `Bearer ${config.openaiKey}` },
    })
    openai.on('open', () => {
      started = true
      updates = caller.callStarted(bridge)
      for (const u of updates) talk?.add('update', u)
      if (updates.length) tools.outside()
      mark('ai.open', { updates: updates.length })
      sendAI({
        type: 'session.update',
        session: {
          type: 'realtime',
          model: config.realtimeModel,
          output_modalities: ['audio'],
          instructions: instructions(updates),
          audio: {
            input: turnSettings(),
            output: { format: { type: 'audio/pcmu' }, voice: config.voice },
          },
          tools: TOOLS,
          tool_choice: 'auto',
        },
      })
      requestResponse('call start')
    })
    openai.on('message', raw => {
      let ev
      try { ev = JSON.parse(raw) } catch { return }
      onAIEvent(ev).catch(err => { log(`realtime event ${ev.type}: ${err.message}`); mark('handler.error', { type: ev.type, error: err.message }) })
    })
    openai.on('error', err => { log(`realtime error: ${err.message}`); mark('ai.error', { error: err.message }) })
    openai.on('close', code => { mark('ai.close', { code }); end() })
  }

  async function onAIEvent(ev) {
    switch (ev.type) {
      case 'response.created':
        responseActive = true
        spoken = ''
        mark('response.created', { id: ev.response?.id })
        break
      case 'response.output_audio.delta':
        if (ev.item_id && ev.item_id !== lastAssistantItem) {
          lastAssistantItem = ev.item_id
          responseStartTs = latestMediaTs
          itemSentMs = 0
        }
        itemSentMs += Buffer.from(ev.delta, 'base64').length / 8 // 8 kHz mu-law: 8 bytes per ms
        sendTwilio({ event: 'media', streamSid, media: { payload: ev.delta } })
        sendTwilio({ event: 'mark', streamSid, mark: { name: 'audio:' + markGen } })
        marksPending++
        break
      case 'response.output_audio_transcript.delta':
        spoken += ev.delta || ''
        break
      case 'response.output_audio_transcript.done':
        talk?.add('anton', ev.transcript)
        mark('anton.said', { text: clip(ev.transcript, 160) })
        break
      case 'input_audio_buffer.speech_started':
        mark('speech.started', { antonTalking: audible() })
        if (serverTurns()) { tools.userSpoke(); userSpoke = true; truncate(); break }
        clearTimeout(bargeTimer)
        if (audible()) bargeTimer = setTimeout(bargeIn, config.bargeInMs)
        break
      case 'input_audio_buffer.speech_stopped':
        clearTimeout(bargeTimer)
        mark('speech.stopped')
        break
      case 'input_audio_buffer.committed':
        if (serverTurns()) break
        clearTimeout(bargeTimer)
        tools.userSpoke()
        userSpoke = true
        if (audible() && !bargedIn) {
          // A short sound over Anton: decide when its words arrive.
          overlapped.add(ev.item_id)
          mark('turn.wait', { item: ev.item_id })
        } else {
          bargedIn = false
          requestResponse('user turn')
        }
        break
      case 'conversation.item.input_audio_transcription.completed': {
        talk?.add('user', ev.transcript)
        mark('user.said', { item: ev.item_id, text: clip(ev.transcript, 160) })
        if (!overlapped.delete(ev.item_id)) break
        const text = String(ev.transcript || '')
        if (isEcho(text, spoken)) mark('turn.ignored', { why: 'echo' })
        else if (isFiller(text) && !/\?\s*$/.test(spoken.trim())) mark('turn.ignored', { why: 'filler' })
        else requestResponse('heard over Anton') // answered after Anton finishes, not cut off
        break
      }
      case 'conversation.item.input_audio_transcription.failed':
        mark('user.said.failed', { item: ev.item_id, error: ev.error?.message })
        overlapped.delete(ev.item_id)
        break
      case 'response.done':
        responseActive = false
        mark('response.done', { status: ev.response?.status, reason: ev.response?.status_details?.reason })
        await onResponseDone(ev.response)
        break
      case 'error':
        log(`realtime: ${ev.error?.message || JSON.stringify(ev.error)}`)
        mark('ai.error', { error: ev.error?.message })
        if (/active response/i.test(ev.error?.message || '')) responseActive = true
        break
    }
  }

  async function onResponseDone(response) {
    // A cut-off response may hold a half-written tool call; it is not run.
    const calls = response?.status === 'cancelled' ? [] : (response?.output || []).filter(o => o.type === 'function_call')
    for (const c of calls) {
      let args = {}
      try { args = JSON.parse(c.arguments || '{}') } catch {}
      const output = await tools.run(c.name, args)
      talk?.add('tool', `${c.name} ${clip(JSON.stringify(args), 200)}`)
      mark('tool', { name: c.name, ok: output?.ok !== false })
      log(`tool ${c.name}`)
      sendAI({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: c.call_id, output: JSON.stringify(output) } })
    }
    if (calls.length) { requestResponse('tool result'); return }
    if (hangupPending) {
      sendTwilio({ event: 'mark', streamSid, mark: { name: 'bye' } })
      return
    }
    if (responseQueued) { responseQueued = false; requestResponse('queued') }
  }

  // The user has talked over Anton long enough to mean it: stop Anton.
  function bargeIn() {
    if (!audible()) return
    bargedIn = true
    mark('barge.in')
    truncate()
    if (responseActive) sendAI({ type: 'response.cancel' })
  }

  function truncate() {
    if (!lastAssistantItem || responseStartTs === null || marksPending === 0) return
    const audioEndMs = Math.round(Math.min(Math.max(0, latestMediaTs - responseStartTs), itemSentMs))
    mark('truncate', { audioEndMs, sentMs: Math.round(itemSentMs) })
    sendAI({ type: 'conversation.item.truncate', item_id: lastAssistantItem, content_index: 0, audio_end_ms: audioEndMs })
    sendTwilio({ event: 'clear', streamSid })
    lastAssistantItem = null
    responseStartTs = null
    marksPending = 0
    markGen++
  }

  twilioWs.on('message', raw => {
    let msg
    try { msg = JSON.parse(raw) } catch { return }
    switch (msg.event) {
      case 'start':
        streamSid = msg.start.streamSid
        callSid = msg.start.callSid
        talk = memory.transcript(callSid)
        trace = callTrace(callSid)
        bridge.callSid = callSid
        log('call connected')
        mark('call.start')
        connectAI()
        break
      case 'media':
        latestMediaTs = Number(msg.media.timestamp) || latestMediaTs
        sendAI({ type: 'input_audio_buffer.append', audio: msg.media.payload })
        break
      case 'mark':
        if (msg.mark?.name === 'audio:' + markGen && marksPending > 0 && --marksPending === 0 && !responseActive) {
          // Everything Anton said has played; nothing left to cut off.
          lastAssistantItem = null
          responseStartTs = null
          mark('anton.done.playing')
        }
        if (msg.mark?.name === 'bye' && callSid) caller.hangUp(callSid)
        break
      case 'stop':
        end()
        break
    }
  })
  twilioWs.on('close', () => end())

  function end() {
    if (ended) return
    ended = true
    clearTimeout(bargeTimer)
    log('call ended')
    mark('call.end')
    trace?.end()
    try { openai?.close() } catch {}
    try { twilioWs.close() } catch {}
    if (started) caller.callEnded({ userSpoke, updates })
    if (talk) (summarize || memory.summarizeCall)(callSid, talk.lines()).catch(err => log(`could not remember the call: ${err.message}`))
  }
}

function clip(s, n) {
  s = String(s || '')
  return s.length > n ? s.slice(0, n) + '...' : s
}
