// A small porch hub for the worker tests, like the one in agents.test.js: tokens
// name the sender, messages live in memory, /v1/stream pushes them as Server-Sent
// Events. onPost(m) sees every post as it is stored; delay holds the answer, so a
// test can kill the worker while its post is in flight.
import http from 'node:http'

// agents: other agents on the hub, besides anton and me.
export function fakePorch({ delay = 0, agents = [] } = {}) {
  const porch = { messages: [], streams: new Set(), members: new Set(), onPost: () => {}, delay, inflight: 0 }
  porch.add = (from, msg) => {
    let room = msg.room || 'general'
    if (msg.dm) room = `dm:${[from, msg.dm].sort().join('+')}`
    let to = msg.to || []
    if (room.startsWith('dm:') && !to.length) to = room.slice(3).split('+').filter(n => n !== from)
    const m = { id: porch.messages.length + 1, ts: new Date().toISOString(), from, room, kind: msg.kind || 'note', priority: msg.priority || 'normal', to, reply_to: msg.reply_to ?? null, text: msg.text }
    porch.messages.push(m)
    for (const res of porch.streams) res.write(`id: ${m.id}\ndata: ${JSON.stringify(m)}\n\n`)
    return m
  }
  porch.server = http.createServer((req, res) => {
    const who = String(req.headers.authorization || '').replace('Bearer ', '')
    const url = new URL(req.url, 'http://x')
    const json = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
    let b = ''
    req.on('data', c => { b += c })
    req.on('end', () => {
      if (url.pathname === '/v1/me') return json(200, { name: who })
      if (url.pathname === '/v1/agents' && req.method === 'POST') { porch.members.add(JSON.parse(b).name); return json(201, {}) }
      if (url.pathname.startsWith('/v1/agents/') && req.method === 'DELETE') return json(200, {})
      if (url.pathname === '/v1/agents') return json(200, ['anton', 'me', ...agents, ...porch.members].map(name => ({ name, lastSeen: new Date().toISOString(), online: true })))
      if (url.pathname === '/v1/stream') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const after = Number(url.searchParams.get('after')) || 0
        for (const m of porch.messages.filter(m => m.id > after)) res.write(`id: ${m.id}\ndata: ${JSON.stringify(m)}\n\n`)
        porch.streams.add(res)
        res.on('close', () => porch.streams.delete(res))
        return
      }
      if (url.pathname === '/v1/messages' && req.method === 'POST') {
        const msg = JSON.parse(b)
        const m = porch.add(msg.as || who, msg)
        porch.inflight++
        try { porch.onPost(m) } catch {}
        setTimeout(() => { porch.inflight--; json(201, m) }, porch.delay)
        return
      }
      if (url.pathname === '/v1/messages') {
        const p = url.searchParams
        const out = porch.messages.filter(m => (!p.get('from') || m.from === p.get('from')) && (!p.get('room') || m.room === p.get('room'))
          && (!p.get('reply_to') || m.reply_to === Number(p.get('reply_to'))) && (!p.get('to') || m.to.includes(p.get('to'))) && (!p.get('after') || m.id > Number(p.get('after'))))
        return json(200, out.slice(-(Number(p.get('limit')) || 50)))
      }
      json(404, { error: 'not found' })
    })
  })
  porch.ready = new Promise(r => porch.server.listen(0, '127.0.0.1', () => { porch.url = `http://127.0.0.1:${porch.server.address().port}`; r() }))
  porch.close = () => { for (const s of porch.streams) s.end(); porch.server.closeAllConnections(); porch.server.close() }
  return porch
}
