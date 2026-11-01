import { fakeSocket, tick } from './setup.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { config } from '../src/config.js'
import { liveCall, sessionConfig } from '../src/live.js'
import { callTools } from '../src/tools.js'

test('settings come from the env, not a developer .env', () => {
  assert.equal(config.porchUrl, '')
  assert.equal(config.myNumber, '+15550001111')
})

// Real tool guardrail, with the tool calls themselves recorded instead of run.
function recordingTools(calls) {
  return opts => {
    const t = callTools(opts)
    return {
      ...t,
      run: async (name, args) => {
        const blocked = t.blocked(name)
        calls.push({ name, args, blocked })
        if (name === 'end_call') return t.run(name, args)
        return blocked ? { ok: false, reason: 'Blocked.' } : { ok: true, name }
      },
    }
  }
}

function start({ calls = [], hangUp = () => {} } = {}) {
  const audio = []
  const ws = fakeSocket()
  const call = liveCall({ callSid: 'CAtest', sendAudio: a => audio.push(a), hangUp, makeTools: recordingTools(calls), hangupDelayMs: 5, summarize: async () => {} })
  call.attach(ws)
  return { ws, call, audio, calls }
}

test('session.start asks for phone audio, the voice, and a backend with Anton\'s tools', () => {
  const { ws } = start()
  const [s] = ws.ofType('session.start')
  assert.ok(s, 'session.start was sent')
  assert.equal(s.session.model, 'gpt-live-1')
  assert.deepEqual(s.session.audio.format, { type: 'audio/pcmu', rate: 8000 })
  assert.equal(s.session.delegation.type, 'responses')
  assert.equal(s.session.delegation.responses.parallel_tool_calls, false)
  const names = s.session.delegation.responses.tools.map(t => t.name)
  for (const n of ['ask_claude', 'get_status', 'answer_permission', 'end_call']) assert.ok(names.includes(n), n)
})

test('SIP settings leave the audio format to SIP and name the session type', () => {
  const s = sessionConfig([], { sip: true })
  assert.equal(s.type, 'live')
  assert.equal(s.audio.format, undefined)
})

test('greets after the session starts, and passes audio both ways unchanged', () => {
  const { ws, call, audio } = start()
  ws.event({ type: 'session.started', session: { id: 'live_1' } })
  assert.equal(ws.ofType('session.commentary.append').length, 1)
  call.audioIn('AAAA')
  assert.deepEqual(ws.ofType('session.input_audio.append').at(-1), { type: 'session.input_audio.append', audio: 'AAAA', event_id: ws.ofType('session.input_audio.append').at(-1).event_id })
  ws.event({ type: 'session.output_audio.delta', delta: 'BBBB' })
  assert.deepEqual(audio, ['BBBB'])
})

test('a backend function call runs the tool, returns its output, and resumes', async () => {
  const { ws, calls } = start()
  ws.event({ type: 'session.input_transcript.delta', delta: 'what is main doing' })
  ws.event({ type: 'response.event', delegation_id: 'd1', event: { type: 'response.output_item.done', item: { type: 'function_call', name: 'get_status', call_id: 'call_1', arguments: '{"session":"main"}' } } })
  await tick(10)
  assert.deepEqual(calls.map(c => c.name), ['get_status'])
  const out = ws.sent.filter(m => m.type === 'response.item.create' || m.type === 'response.create')
  assert.equal(out[0].type, 'response.item.create')
  assert.equal(out[0].item.call_id, 'call_1')
  assert.equal(out[1].type, 'response.create')
})

test('an action right after an outside update is blocked until the caller speaks', async () => {
  const { ws, call, calls } = start()
  ws.event({ type: 'session.input_transcript.delta', delta: 'hi' })
  call.bridge.inject('Claude asks: may I delete the build folder?')
  const [c] = ws.ofType('session.commentary.append').slice(-1)
  assert.match(c.content, /not said by Sam/)
  assert.equal(c.delegation_id, null)
  const fc = id => ({ type: 'response.event', event: { type: 'response.output_item.done', item: { type: 'function_call', name: 'answer_permission', call_id: id, arguments: '{"approve":true}' } } })
  ws.event(fc('c1'))
  await tick(10)
  assert.equal(calls.at(-1).blocked, true)
  ws.event({ type: 'session.input_transcript.delta', delta: 'yes go ahead' })
  ws.event(fc('c2'))
  await tick(10)
  assert.equal(calls.at(-1).blocked, false)
})

test('end_call hangs up after the goodbye', async () => {
  let hung = 0
  const { ws } = start({ hangUp: () => hung++ })
  ws.event({ type: 'session.input_transcript.delta', delta: 'bye' })
  ws.event({ type: 'response.event', event: { type: 'response.output_item.done', item: { type: 'function_call', name: 'end_call', call_id: 'c9', arguments: '{}' } } })
  await tick(30)
  assert.equal(hung, 1)
})

test('transcript deltas become one line per speaker turn, and the call closes once', async () => {
  const lines = []
  const ws = fakeSocket()
  const call = liveCall({ callSid: 'CAlines', makeTools: recordingTools([]), summarize: async (_, l) => lines.push(...l) })
  call.attach(ws)
  for (const d of ['Can you ', 'check main?']) ws.event({ type: 'session.input_transcript.delta', delta: d })
  for (const d of ['Sure, ', 'checking.']) ws.event({ type: 'session.output_transcript.delta', delta: d })
  ws.event({ type: 'session.closed', reason: 'close_requested' })
  ws.emit('close')
  await tick(5)
  assert.deepEqual(lines.map(l => `${l.who}: ${l.text}`), ['user: Can you check main?', 'anton: Sure, checking.'])
  assert.equal(ws.ofType('session.close').length, 1)
})
