import { tick } from './setup.js'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

// A small porch hub, as in agents.test.js.
const messages = []
const streams = new Set()
function add(from, msg) {
  let room = msg.room || 'general'
  if (msg.dm) room = `dm:${[from, msg.dm].sort().join('+')}`
  let to = msg.to || []
  if (room.startsWith('dm:') && !to.length) to = room.slice(3).split('+').filter(n => n !== from)
  const m = { id: messages.length + 1, ts: new Date().toISOString(), from, room, kind: msg.kind || 'note', priority: msg.priority || 'normal', to, reply_to: msg.reply_to ?? null, text: msg.text }
  messages.push(m)
  for (const res of streams) res.write(`id: ${m.id}\ndata: ${JSON.stringify(m)}\n\n`)
  return m
}
const server = http.createServer((req, res) => {
  const who = String(req.headers.authorization || '').replace('Bearer ', '')
  const url = new URL(req.url, 'http://x')
  const json = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
  if (url.pathname === '/v1/me') return json(200, { name: who })
  if (url.pathname === '/v1/agents') return json(200, [{ name: 'anton' }, { name: 'me' }, { name: 'grokbot' }])
  if (url.pathname === '/v1/stream') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); streams.add(res); req.on('close', () => streams.delete(res)); return }
  if (url.pathname === '/v1/messages' && req.method === 'POST') { let b = ''; req.on('data', c => { b += c }); req.on('end', () => json(201, add(who, JSON.parse(b)))); return }
  if (url.pathname === '/v1/messages') {
    const p = url.searchParams
    return json(200, messages.filter(m => (!p.get('to') || m.to.includes(p.get('to'))) && (!p.get('room') || m.room === p.get('room'))).slice(-(Number(p.get('limit')) || 50)))
  }
  if (url.pathname === '/v1/agents' && req.method === 'POST') return json(403, { error: 'no' })
  json(404, {})
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
process.env.PORCH_URL = `http://127.0.0.1:${server.address().port}`
process.env.PORCH_TOKEN = 'anton'
process.env.PORCH_CALL_ON = 'for-me,urgent'

const hub = await import('../src/hub.js')
const gate = await import('../src/callgate.js')
const phone = []
const seen = []
let decision = 'hold'
hub.setCallGate(async ctx => { seen.push(ctx); return { decision, reason: 'test' } })
await hub.start(n => phone.push(n))
await tick(100)
after(() => { hub.stop(); for (const s of streams) s.end(); server.close() })

const FYI = 'FYI from Nithin: I will post application and event status updates in the jobs room from time to time. These are informational. Please do not call Nithin about them. Also, the Founders Inc question is resolved.'

test('an informational post addressed to Anton is held, not rung', async () => {
  decision = 'hold'
  add('grokbot', { dm: 'anton', text: FYI })
  await tick(200)
  assert.equal(phone.length, 1)
  assert.equal(phone[0].ring, false, 'kept for the next call, no ring')
  assert.match(seen.at(-1).m.text, /informational/)
})

test('the gate sees the recent thread around the post', async () => {
  add('grokbot', { room: 'jobs', text: 'Applications status: 16 applied, no replies yet. Informational only.' })
  add('grokbot', { dm: 'anton', text: 'One more status note for the record.' })
  await tick(200)
  assert.ok(seen.at(-1).recent.some(r => /informational/i.test(r.text)), 'earlier "do not call" context is passed along')
})

test('skip drops it; call rings', async () => {
  const before = phone.length
  decision = 'skip'
  add('grokbot', { dm: 'anton', text: 'Thanks!' })
  await tick(200)
  assert.equal(phone.length, before, 'nothing queued or rung')
  decision = 'call'
  add('grokbot', { dm: 'anton', priority: 'high', kind: 'alert', text: 'The host approved Nithin for Founders Inc; he must confirm by 6 pm today or the spot is released.' })
  await tick(200)
  assert.equal(phone.at(-1).ring, true)
})

test('posts not addressed to Anton and not urgent never reach the gate', async () => {
  const n = seen.length
  add('grokbot', { room: 'jobs', text: 'Weekly status.' })
  await tick(200)
  assert.equal(seen.length, n)
})

test('decide: parses the model, and holds when the model fails or rambles', async () => {
  assert.deepEqual(await gate.decide({ m: { from: 'x', room: 'r', text: 't' } }, { askFn: async () => '{"decision":"call","reason":"deadline today"}' }), { decision: 'call', reason: 'deadline today' })
  assert.equal((await gate.decide({ m: { from: 'x', room: 'r', text: 't' } }, { askFn: async () => 'I think you should call' })).decision, 'hold')
  assert.equal((await gate.decide({ m: { from: 'x', room: 'r', text: 't' } }, { askFn: async () => { throw new Error('down') } })).decision, 'hold')
})

test('the prompt carries the post, the thread and the preferences', () => {
  const p = gate.gatePrompt({ m: { from: 'grokbot', room: 'jobs', text: FYI, to: ['anton'] }, recent: [{ from: 'grokbot', text: 'earlier post' }], notes: 'Sam does not want calls about job updates.' })
  assert.match(p, /do not call/i)
  assert.match(p, /earlier post/)
  assert.match(p, /does not want calls about job updates/)
})
