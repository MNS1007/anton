import { tick } from './setup.js'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

// A small porch hub: tokens name the sender, messages are kept in memory, and
// /v1/stream pushes new ones as Server-Sent Events.
const messages = []
const streams = new Set()
const seen = { anton: '2026-11-01T10:00:00Z', me: '2026-11-01T10:00:00Z', muse: '2026-11-01T09:00:00Z', grokbot: '2026-11-01T08:00:00Z' }
function add(from, msg) {
  const m = { id: messages.length + 1, ts: new Date().toISOString(), from, room: msg.room || 'general', kind: msg.kind || 'note', to: msg.to || [], reply_to: msg.reply_to ?? null, text: msg.text }
  messages.push(m)
  for (const res of streams) res.write(`id: ${m.id}\ndata: ${JSON.stringify(m)}\n\n`)
  return m
}
const server = http.createServer((req, res) => {
  const who = String(req.headers.authorization || '').replace('Bearer ', '')
  const url = new URL(req.url, 'http://x')
  const json = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
  if (url.pathname === '/v1/me') return json(200, { name: who })
  if (url.pathname === '/v1/agents') return json(200, Object.entries(seen).map(([name, lastSeen]) => ({ name, lastSeen, online: name === 'anton' })))
  if (url.pathname === '/v1/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    streams.add(res)
    req.on('close', () => streams.delete(res))
    return
  }
  if (url.pathname === '/v1/messages' && req.method === 'POST') {
    let b = ''
    req.on('data', c => { b += c })
    req.on('end', () => json(201, add(who, JSON.parse(b))))
    return
  }
  if (url.pathname === '/v1/messages') {
    const p = url.searchParams
    let out = messages.filter(m => (!p.get('from') || m.from === p.get('from')) && (!p.get('q') || m.text.toLowerCase().includes(p.get('q').toLowerCase())) && (!p.get('after') || m.id > Number(p.get('after'))))
    return json(200, out.slice(-(Number(p.get('limit')) || 50)))
  }
  json(404, {})
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
process.env.PORCH_URL = `http://127.0.0.1:${server.address().port}`
process.env.PORCH_TOKEN = 'anton'
after(() => { hub.stop(); for (const s of streams) s.end(); server.close() })

const LONG = 'Research Briefing. ' + 'World models are becoming spatially persistent. '.repeat(80) + 'Dashboard: https://example.com/dash/42'
add('muse', { room: 'research', kind: 'briefing', text: LONG })
add('grokbot', { room: 'jobs', kind: 'briefing', text: 'Applied to 15 companies.' })

const agent = await import('../src/agent.js')
const hub = await import('../src/hub.js')
const agents = await import('../src/agents.js')
const notices = []
agent.onNotify(n => notices.push(n))
await hub.start(null)
await tick(100)

test('lists Claude sessions and porch agents, not Anton or the owner', async () => {
  const { agents: all } = await agents.listAgents()
  const names = all.map(a => a.name)
  assert.ok(names.includes('main'))
  assert.ok(names.includes('muse') && names.includes('grokbot'))
  assert.ok(!names.includes('anton') && !names.includes('me'))
  assert.match(all.find(a => a.name === 'grokbot').latest, /Applied to 15/)
})

test('reads an agent\'s work in full, with its links', async () => {
  const w = await agents.agentWork('muse')
  assert.equal(w.posts.length, 1)
  assert.equal(w.posts[0].text, LONG)
  assert.deepEqual(w.links, ['https://example.com/dash/42'])
  const none = await agents.agentWork('muse', { query: 'quantum' })
  assert.equal(none.posts.length, 0)
})

test('asks a porch agent; a reply in the thread comes back as the result', async () => {
  const r = await agents.askAgent('grokbot', 'Find three robotics roles')
  assert.equal(r.ok, true)
  assert.match(r.note, /next time it runs/)
  await tick(100)
  const task = messages.at(-1)
  assert.equal(task.from, 'anton')
  assert.deepEqual(task.to, ['grokbot'])
  assert.equal(agent.status('grokbot').running, true)
  add('grokbot', { room: 'jobs', text: 'Unrelated status post.' })
  await tick(100)
  assert.equal(agent.status('grokbot').running, true, 'a post outside the thread does not count')
  add('grokbot', { room: task.room, reply_to: task.id, text: 'Found: A, B and C.' })
  await tick(200)
  assert.equal(agent.status('grokbot').running, false)
  assert.equal(agent.status('grokbot').lastResult, 'Found: A, B and C.')
  assert.match(notices.at(-1).text, /grokbot replied/)
})

test('an unknown agent gets a list of the real ones', async () => {
  const r = await agents.askAgent('nobody', 'hi')
  assert.equal(r.ok, false)
  assert.match(r.reason, /muse/)
})

test('porch commands: "agents" and "<agent>: task" from the owner', async () => {
  const before = messages.length
  add('me', { room: 'anton', to: ['anton'], text: 'agents' })
  await tick(200)
  const list = messages.slice(before).find(m => m.from === 'anton' && m.kind === 'answer')
  assert.match(list.text, /muse \(agent on porch\)/)
  add('me', { room: 'anton', to: ['anton'], text: 'muse: summarize today\'s briefing in three lines' })
  await tick(200)
  const sent = messages.filter(m => m.from === 'anton' && m.to.includes('muse')).at(-1)
  assert.match(sent.text, /summarize today/)
  add('muse', { room: sent.room, reply_to: sent.id, text: 'Three lines.' })
  await tick(200)
  const back = messages.filter(m => m.from === 'anton' && m.to.includes('me')).at(-1)
  assert.match(back.text, /\[muse\] Three lines\./)
})
