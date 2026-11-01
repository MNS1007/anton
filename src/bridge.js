// One phone call: Twilio media stream <-> OpenAI Realtime, with tools that drive Claude.
import WebSocket from 'ws'
import { config } from './config.js'
import { log } from './log.js'
import * as caller from './caller.js'
import * as memory from './memory.js'
import { TOOLS, instructions, callTools } from './tools.js'

const user = config.userName

export function handleCall(twilioWs) {
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
  // for cutting off Anton when the user talks over it
  let latestMediaTs = 0
  let responseStartTs = null
  let lastAssistantItem = null
  // OpenAI sends audio faster than it plays, so Anton is still talking after
  // response.done. Twilio echoes each mark when the audio before it has played.
  let marksPending = 0
  let markGen = 0 // bumped on each cut-off; Twilio echoes the marks it drops, and those are ignored
  let itemSentMs = 0
  // Guardrail: actions need the user to have spoken after the latest outside message.
  const tools = callTools({ onHangup: () => { hangupPending = true } })

  const bridge = {
    callSid: null,
    inject(text) {
      talk?.add('update', text)
      tools.outside()
      sendAI({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: `[Update from Claude Code, not said by ${user}] ${text}\nTell ${user} the gist briefly.` }],
        },
      })
      requestResponse()
    },
  }

  const sendAI = obj => { if (openai?.readyState === WebSocket.OPEN) openai.send(JSON.stringify(obj)) }
  const sendTwilio = obj => { if (twilioWs.readyState === WebSocket.OPEN) twilioWs.send(JSON.stringify(obj)) }

  function requestResponse() {
    if (responseActive) { responseQueued = true; return }
    responseActive = true
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
      sendAI({
        type: 'session.update',
        session: {
          type: 'realtime',
          model: config.realtimeModel,
          output_modalities: ['audio'],
          instructions: instructions(updates),
          audio: {
            input: { format: { type: 'audio/pcmu' }, transcription: { model: config.transcribeModel }, turn_detection: { type: 'semantic_vad' } },
            output: { format: { type: 'audio/pcmu' }, voice: config.voice },
          },
          tools: TOOLS,
          tool_choice: 'auto',
        },
      })
      requestResponse()
    })
    openai.on('message', raw => onAIEvent(JSON.parse(raw)))
    openai.on('error', err => log(`realtime error: ${err.message}`))
    openai.on('close', () => end())
  }

  async function onAIEvent(ev) {
    switch (ev.type) {
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
      case 'conversation.item.input_audio_transcription.completed':
        talk?.add('user', ev.transcript)
        break
      case 'response.output_audio_transcript.done':
        talk?.add('anton', ev.transcript)
        break
      case 'input_audio_buffer.speech_started':
        tools.userSpoke()
        userSpoke = true
        truncate()
        break
      case 'response.done':
        responseActive = false
        await onResponseDone(ev.response)
        break
      case 'error':
        log(`realtime: ${ev.error?.message || JSON.stringify(ev.error)}`)
        if (/active response/i.test(ev.error?.message || '')) responseActive = true
        break
    }
  }

  async function onResponseDone(response) {
    const calls = (response?.output || []).filter(o => o.type === 'function_call')
    for (const c of calls) {
      let args = {}
      try { args = JSON.parse(c.arguments || '{}') } catch {}
      const output = await tools.run(c.name, args)
      talk?.add('tool', `${c.name} ${clip(JSON.stringify(args), 200)}`)
      log(`tool ${c.name}`)
      sendAI({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: c.call_id, output: JSON.stringify(output) } })
    }
    if (calls.length) { requestResponse(); return }
    if (hangupPending) {
      sendTwilio({ event: 'mark', streamSid, mark: { name: 'bye' } })
      return
    }
    if (responseQueued) { responseQueued = false; requestResponse() }
  }

  function truncate() {
    if (!lastAssistantItem || responseStartTs === null || marksPending === 0) return
    const audioEndMs = Math.round(Math.min(Math.max(0, latestMediaTs - responseStartTs), itemSentMs))
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
        bridge.callSid = callSid
        log('call connected')
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
    log('call ended')
    try { openai?.close() } catch {}
    try { twilioWs.close() } catch {}
    if (started) caller.callEnded({ userSpoke, updates })
    if (talk) memory.summarizeCall(callSid, talk.lines()).catch(err => log(`could not remember the call: ${err.message}`))
  }
}

function clip(s, n) {
  s = String(s || '')
  return s.length > n ? s.slice(0, n) + '...' : s
}
