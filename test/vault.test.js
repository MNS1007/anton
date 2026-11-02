import './setup.js'
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const agent = await import('../src/agent.js')
const vault = await import('../src/vault.js')

const PLANTED = 'sk-PLANTED-SECRET-123'
const HANDLE = 'pvh_' + 'h'.repeat(43)
const HANDLE2 = 'pvh_' + 'g'.repeat(43)

// A stand-in for porch's vault routes. The owner approves by setting a status;
// the handle comes out once, the way porch's agent-api gives it.
const porch = { requests: [], calls: [] }
function stubFetch(url, opts = {}) {
  const u = new URL(url)
  porch.calls.push({ method: opts.method || 'GET', path: u.pathname + u.search, body: opts.body ? JSON.parse(opts.body) : null, auth: opts.headers.Authorization })
  const reply = (status, body) => Promise.resolve({ ok: status < 300, status, json: async () => body })
  if (u.pathname === '/v1/vault/requests' && opts.method === 'POST') {
    const b = JSON.parse(opts.body)
    const r = { id: porch.requests.length + 1, agent: b.as, secret: b.secret, provider: b.secret === 'gemini' ? 'gemini' : 'openai', status: 'pending', handle: null }
    porch.requests.push(r)
    return reply(201, { id: r.id, agent: r.agent, status: r.status })
  }
  if (u.pathname === '/v1/vault') {
    const as = u.searchParams.get('as')
    return reply(200, { secrets: [], grants: [], requests: porch.requests.filter(r => r.agent === as).map(({ handle, ...r }) => r) })
  }
  const m = u.pathname.match(/^\/v1\/vault\/requests\/(\d+)$/)
  if (m) {
    const r = porch.requests.find(x => x.id === Number(m[1]))
    if (!r) return reply(404, { error: 'No such vault request of yours.' })
    const out = { id: r.id, agent: r.agent, secret: r.secret, status: r.status }
    if (r.status === 'approved') {
      Object.assign(out, { provider: r.provider, grant: { id: r.id, expires: r.expires }, handle: r.handle })
      r.handle = null
    }
    return reply(200, out)
  }
  return reply(404, { error: 'Not found' })
}

const approve = (id, handle, expires = new Date(Date.now() + 864e5).toISOString()) =>
  Object.assign(porch.requests.find(r => r.id === id), { status: 'approved', handle, expires })

let logs = [], orig
before(() => {
  orig = console.log
  console.log = (...a) => { logs.push(a.join(' ')); orig(...a) }
  agent.createSession({ name: 'vision', purpose: 'robot vision' })
  vault.start({ fetch: stubFetch, url: 'http://porch.test', token: 'anton-token', vaultPort: 7778, every: 1e9 })
})
after(() => { console.log = orig; vault.stop() })

const ask = { secret: 'openai-main', purpose: 'tests', scope: { models: ['gpt-5.4-mini'], endpoints: ['chat/completions'] }, budget: { per_request_usd: 1, daily_usd: 2, total_usd: 5, rate_per_min: 30, days: 7 } }

test('asks porch as the session member, with Anton\'s own token', async () => {
  const r = await vault.request('vision', ask)
  assert.equal(r.ok, true)
  const c = porch.calls.at(-1)
  assert.equal(c.body.as, 'claude-code/vision')
  assert.equal(c.auth, 'Bearer anton-token')
  assert.deepEqual(vault.envFor('vision'), {})
})

test('nothing while pending; after approval the session env points at the proxy', async () => {
  await vault.poll()
  assert.deepEqual(vault.envFor('vision'), {})
  approve(1, HANDLE)
  await vault.poll()
  assert.deepEqual(vault.envFor('vision'), { OPENAI_BASE_URL: 'http://127.0.0.1:7778/vault/proxy/openai/v1', OPENAI_API_KEY: HANDLE })
  // Only that session gets it.
  assert.deepEqual(vault.envFor('main'), {})
  // Settled: porch is not asked for it again.
  const before = porch.calls.filter(c => c.path === '/v1/vault/requests/1').length
  await vault.poll()
  assert.equal(porch.calls.filter(c => c.path === '/v1/vault/requests/1').length, before)
})

test('a grant the session asked for itself is found; Gemini grants use the Gemini variables', async () => {
  // A request made by the session itself over MCP is found from the vault list.
  porch.requests.push({ id: 2, agent: 'claude-code/vision', secret: 'gemini', provider: 'gemini', status: 'pending', handle: null })
  await vault.poll()
  approve(2, HANDLE2)
  await vault.poll()
  const env = vault.envFor('vision')
  assert.equal(env.GOOGLE_GEMINI_BASE_URL, 'http://127.0.0.1:7778/vault/proxy/gemini')
  assert.equal(env.GEMINI_API_KEY, HANDLE2)
  assert.equal(env.OPENAI_API_KEY, HANDLE)
  assert.equal(typeof agent.onTaskEnv, 'function')
  assert.deepEqual(vault.grants('vision').map(g => g.provider).sort(), ['gemini', 'openai'])
  assert.ok(!JSON.stringify(vault.grants('vision')).includes('pvh_'))
})

test('a request for another family member is not picked up for a session', async () => {
  porch.requests.push({ id: 3, agent: 'claude-code/main', secret: 'gemini', provider: 'gemini', status: 'approved', handle: 'pvh_' + 'x'.repeat(43), expires: new Date(Date.now() + 864e5).toISOString() })
  porch.requests.push({ id: 4, agent: 'muse', secret: 'gemini', provider: 'gemini', status: 'approved', handle: 'pvh_' + 'y'.repeat(43), expires: new Date(Date.now() + 864e5).toISOString() })
  await vault.poll()
  assert.equal(vault.envFor('main').GEMINI_API_KEY, 'pvh_' + 'x'.repeat(43))
  assert.ok(!JSON.stringify(vault.envFor('vision')).includes('y'.repeat(43)))
  assert.ok(!porch.calls.some(c => c.path === '/v1/vault/requests/4'))
})

test('denied, already given out and expired grants give no env', async () => {
  await vault.request('main', ask)
  const id = porch.requests.length
  Object.assign(porch.requests[id - 1], { status: 'denied' })
  await vault.request('main', { ...ask, secret: 'gemini' })
  Object.assign(porch.requests.at(-1), { status: 'approved', handle: null, expires: new Date().toISOString() })
  await vault.poll()
  assert.equal(vault.envFor('main').OPENAI_API_KEY, undefined)
  // An expired grant drops out of the env.
  const late = await vault.request('main', ask)
  approve(late.id, 'pvh_' + 'z'.repeat(43), new Date(Date.now() - 1000).toISOString())
  await vault.poll()
  assert.equal(vault.envFor('main').OPENAI_API_KEY, undefined)
})

test('a removed session loses its handles', async () => {
  assert.ok(vault.envFor('vision').OPENAI_API_KEY)
  agent.removeSession('vision')
  await vault.poll()
  assert.deepEqual(vault.envFor('vision'), {})
})

test('handles and the planted key never reach disk or the log', () => {
  const files = []
  const walk = d => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : files.push(p) } }
  walk(process.env.ANTON_HOME)
  assert.ok(files.length > 0, 'sessions.json was saved')
  const disk = files.map(f => readFileSync(f, 'utf8')).join('\n')
  const out = logs.join('\n')
  assert.ok(logs.some(l => l.includes('vault:')), 'vault logged something')
  for (const bad of [HANDLE, HANDLE2, 'pvh_', PLANTED]) {
    assert.ok(!disk.includes(bad), `${bad.slice(0, 8)} on disk`)
    assert.ok(!out.includes(bad), `${bad.slice(0, 8)} in the log`)
  }
})

test('a porch error never carries a handle into the log', async () => {
  const leaky = (url, opts) => Promise.resolve({ ok: false, status: 500, json: async () => ({ error: { handle: HANDLE }, detail: PLANTED }) })
  vault.start({ fetch: leaky, every: 1e9 })
  await assert.rejects(vault.request('main', ask), err => !err.message.includes('pvh_') && !err.message.includes(PLANTED))
  vault.start({ fetch: stubFetch, every: 1e9 })
})
