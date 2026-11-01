// Checks the OpenAI Realtime setup without a phone call:
// session settings accepted, a tool call made, and audio returned.
import WebSocket from 'ws'
import { config } from '../src/config.js'

if (!config.openaiKey) {
  console.error('OPENAI_API_KEY is missing in .env')
  process.exit(1)
}

const model = config.realtimeModel
const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, {
  headers: { Authorization: `Bearer ${config.openaiKey}` },
})
const send = o => ws.send(JSON.stringify(o))
let audioBytes = 0
let toolCalled = false
let failed = false

ws.on('open', () => {
  send({
    type: 'session.update',
    session: {
      type: 'realtime',
      model,
      output_modalities: ['audio'],
      instructions: 'You are a phone assistant. Be brief. Use get_status when asked what Claude is doing.',
      audio: {
        input: { format: { type: 'audio/pcmu', rate: 8000 }, turn_detection: { type: 'semantic_vad' } },
        output: { format: { type: 'audio/pcmu', rate: 8000 }, voice: config.voice },
      },
      tools: [{ type: 'function', name: 'get_status', description: 'What Claude is doing now.', parameters: { type: 'object', properties: {} } }],
      tool_choice: 'auto',
    },
  })
  send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'What is Claude doing right now?' }] } })
  send({ type: 'response.create' })
})

ws.on('message', raw => {
  const ev = JSON.parse(raw)
  if (ev.type === 'session.updated') {
    console.log(`ok   session accepted (${model}, input ${JSON.stringify(ev.session?.audio?.input?.format)})`)
  } else if (ev.type === 'error') {
    failed = true
    console.log(`FAIL ${ev.error?.message}`)
  } else if (ev.type === 'response.output_audio.delta') {
    audioBytes += Buffer.from(ev.delta, 'base64').length
  } else if (ev.type === 'response.output_audio_transcript.done') {
    console.log(`ok   said: "${ev.transcript}"`)
  } else if (ev.type === 'response.done') {
    const call = (ev.response.output || []).find(o => o.type === 'function_call')
    if (call && !toolCalled) {
      toolCalled = true
      console.log(`ok   tool called: ${call.name}`)
      send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: call.call_id, output: JSON.stringify({ running: true, task: 'running the tests', minutesRunning: 4 }) } })
      send({ type: 'response.create' })
      return
    }
    const ok = !failed && toolCalled && audioBytes > 0
    console.log(`${audioBytes > 0 ? 'ok  ' : 'FAIL'} audio returned: ${(audioBytes / 8000).toFixed(1)} s`)
    console.log(ok ? 'Voice setup works.' : 'Voice setup has problems; see above.')
    ws.close()
    process.exit(ok ? 0 : 1)
  }
})
ws.on('error', err => { console.log(`FAIL ${err.message}`); process.exit(1) })
setTimeout(() => { console.log('FAIL timed out'); process.exit(1) }, 30000)
