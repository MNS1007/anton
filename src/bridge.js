// One phone call: Twilio media stream <-> OpenAI Realtime, with tools that drive Claude.
import WebSocket from 'ws'
import { config } from './config.js'
import { log } from './log.js'
import * as agent from './agent.js'
import * as caller from './caller.js'

const name = config.assistantName
const user = config.userName

const TOOLS = [
  {
    type: 'function',
    name: 'ask_claude',
    description: 'Send a task or a follow-up message to Claude Code on the laptop. Write it as a clear, complete instruction in the user\'s own words. Claude remembers earlier messages in this session.',
    parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
  },
  {
    type: 'function',
    name: 'get_status',
    description: 'What Claude is doing now, its latest update, its last result, and any permission it is waiting for.',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function',
    name: 'answer_permission',
    description: 'Answer the permission request Claude is waiting on. Only approve if the user clearly said yes to this exact request.',
    parameters: {
      type: 'object',
      properties: {
        approve: { type: 'boolean' },
        note: { type: 'string', description: 'Optional reason or instruction to pass to Claude, mainly when denying.' },
      },
      required: ['approve'],
    },
  },
  {
    type: 'function',
    name: 'stop_task',
    description: 'Stop the task Claude is working on.',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function',
    name: 'new_session',
    description: 'Start a fresh Claude conversation for the next task, forgetting the earlier one.',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function',
    name: 'end_call',
    description: 'Hang up after saying a short goodbye. Use when the user is done.',
    parameters: { type: 'object', properties: {} },
  },
]

function instructions(updates) {
  const s = agent.status()
  const opening = updates.length
    ? `You placed or picked up this call because of these updates. Tell ${user} the gist in one or two short sentences, then ask what they want to do:\n- ${updates.join('\n- ')}`
    : `${user} called you. Greet them in a few words and ask what they need.`
  return `You are ${name}, a phone assistant for ${user}. You sit between ${user} and Claude Code, an AI coding agent running on their laptop in ${s.workDir}.
You do not do the work yourself. You pass tasks to Claude with ask_claude, check on it with get_status, and relay what it says.

How to talk:
- Short, plain spoken sentences. One to three at a time. No lists, no markdown, no reading code or file paths character by character.
- Summarize Claude's replies; never read them out in full unless asked.
- Never read out secrets, keys, tokens or passwords.
- If you did not catch something, ask again rather than guess.

Permissions:
- When Claude asks permission, say in plain words what it wants to do and ask yes or no.
- Call answer_permission with approve true only if ${user} clearly says yes to that request. Anything unclear is a no or a question back.

Claude right now: ${s.running ? `working on "${s.task}" for ${s.minutesRunning} min.` : 'idle.'}${s.waitingForPermission ? ` It is waiting for permission to ${s.waitingForPermission}` : ''}

${opening}`
}

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
  // for cutting off Anton when the user talks over it
  let latestMediaTs = 0
  let responseStartTs = null
  let lastAssistantItem = null

  const bridge = {
    callSid: null,
    inject(text) {
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
      sendAI({
        type: 'session.update',
        session: {
          type: 'realtime',
          model: config.realtimeModel,
          output_modalities: ['audio'],
          instructions: instructions(updates),
          audio: {
            input: { format: { type: 'audio/pcmu', rate: 8000 }, turn_detection: { type: 'semantic_vad' } },
            output: { format: { type: 'audio/pcmu', rate: 8000 }, voice: config.voice },
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
        if (responseStartTs === null) responseStartTs = latestMediaTs
        if (ev.item_id) lastAssistantItem = ev.item_id
        sendTwilio({ event: 'media', streamSid, media: { payload: ev.delta } })
        sendTwilio({ event: 'mark', streamSid, mark: { name: 'audio' } })
        break
      case 'input_audio_buffer.speech_started':
        userSpoke = true
        truncate()
        break
      case 'response.done':
        responseActive = false
        responseStartTs = null
        lastAssistantItem = null
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
      const output = runTool(c.name, args)
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

  function runTool(toolName, args) {
    switch (toolName) {
      case 'ask_claude': return agent.ask(String(args.message || ''))
      case 'get_status': return agent.status()
      case 'answer_permission': return agent.answerPermission(!!args.approve, args.note)
      case 'stop_task': return agent.stop()
      case 'new_session': return agent.newSession()
      case 'end_call': hangupPending = true; return { ok: true, note: 'Say a short goodbye now.' }
      default: return { ok: false, reason: `unknown tool ${toolName}` }
    }
  }

  function truncate() {
    if (!lastAssistantItem || responseStartTs === null) return
    const audioEndMs = Math.max(0, latestMediaTs - responseStartTs)
    sendAI({ type: 'conversation.item.truncate', item_id: lastAssistantItem, content_index: 0, audio_end_ms: audioEndMs })
    sendTwilio({ event: 'clear', streamSid })
    lastAssistantItem = null
    responseStartTs = null
  }

  twilioWs.on('message', raw => {
    let msg
    try { msg = JSON.parse(raw) } catch { return }
    switch (msg.event) {
      case 'start':
        streamSid = msg.start.streamSid
        callSid = msg.start.callSid
        bridge.callSid = callSid
        log('call connected')
        connectAI()
        break
      case 'media':
        latestMediaTs = Number(msg.media.timestamp) || latestMediaTs
        sendAI({ type: 'input_audio_buffer.append', audio: msg.media.payload })
        break
      case 'mark':
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
  }
}
