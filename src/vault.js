// API keys for Anton's Claude Code sessions, through the porch vault.
// A session never gets a real key. When the owner approves a request made for a
// session (claude-code/<session> on porch), Anton fetches the capability handle
// once, keeps it in memory only, and starts that session's tasks with env that
// points the OpenAI or Gemini client at the vault's proxy with the handle as the key.
// Handles are never written to disk, logged, posted or put in a notice.
import { config } from './config.js'
import { log } from './log.js'
import { agent } from './runner.js'

const pending = new Map() // request id -> session name, until it is decided
const done = new Set()    // request ids already settled, so they are not fetched again
const held = new Map()    // session -> Map(provider -> { handle, secret, expires, grant })
let deps = { fetch: (...a) => fetch(...a), url: config.porchUrl, token: config.porchToken, vaultPort: Number(process.env.PORCH_VAULT_PORT || 7778), now: () => Date.now() }
let timer = null

const member = session => `${config.claudeFamily}/${session}`
const sessionOf = name => String(name || '').startsWith(config.claudeFamily + '/') ? name.slice(config.claudeFamily.length + 1) : null
const proxy = provider => `http://127.0.0.1:${deps.vaultPort}/vault/proxy/${provider}`

async function call(path, opts = {}) {
  const r = await deps.fetch(deps.url + path, { ...opts, headers: { Authorization: `Bearer ${deps.token}`, 'Content-Type': 'application/json' } })
  const body = await r.json().catch(() => ({}))
  // Only porch's own short error text goes on; never the body, which may hold a handle.
  if (!r.ok) throw Object.assign(new Error(typeof body.error === 'string' ? body.error.slice(0, 200) : `porch answered ${r.status}`), { status: r.status })
  return body
}

// Ask the owner for a key for one session. The owner decides on the vault page.
export async function request(session, { secret, purpose, scope, budget, replaces_grant } = {}) {
  const r = await call('/v1/vault/requests', { method: 'POST', body: JSON.stringify({ as: member(session), secret, purpose, scope, budget, replaces_grant }) })
  pending.set(r.id, session)
  log(`vault: asked for ${secret} for the ${session} session (request ${r.id})`)
  return { ok: true, id: r.id, status: r.status }
}

// Follow a request made some other way (for example by the session through MCP).
export function track(session, requestId) {
  if (!done.has(Number(requestId))) pending.set(Number(requestId), session)
}

// Check porch: find requests made for Anton's sessions, and pick up approved handles.
export async function poll() {
  const local = new Set(agent.list().filter(s => !s.porchAgent).map(s => s.name))
  for (const s of held.keys()) if (!local.has(s)) held.delete(s)
  for (const session of local) {
    let mine
    try { mine = await call(`/v1/vault?as=${encodeURIComponent(member(session))}`) } catch { continue }
    for (const r of mine.requests || []) {
      if (sessionOf(r.agent) === session && ['pending', 'approved'].includes(r.status)) track(session, r.id)
    }
  }
  for (const [id, session] of [...pending]) {
    let s
    try { s = await call(`/v1/vault/requests/${id}`) } catch (err) {
      if (err.status === 404) { pending.delete(id); done.add(id) }
      continue
    }
    if (s.status === 'pending') continue
    pending.delete(id)
    done.add(id)
    if (s.status === 'approved' && typeof s.handle === 'string' && s.handle.startsWith('pvh_') && s.provider) {
      keep(session, s)
      log(`vault: ${s.secret} (${s.provider}) is ready for the ${session} session`)
    } else {
      log(`vault: request ${id} for the ${session} session is ${s.status}${s.status === 'approved' ? ', but its handle was already given out' : ''}`)
    }
  }
}

function keep(session, s) {
  if (!held.has(session)) held.set(session, new Map())
  held.get(session).set(s.provider, { handle: s.handle, secret: s.secret, expires: s.grant?.expires || null, grant: s.grant?.id ?? null })
}

// The env a session's task starts with. Empty when it holds no live grant.
export function envFor(session) {
  const grants = held.get(session)
  if (!grants) return {}
  const env = {}
  for (const [provider, g] of grants) {
    if (g.expires && Date.parse(g.expires) <= deps.now()) { grants.delete(provider); continue }
    if (provider === 'openai') Object.assign(env, { OPENAI_BASE_URL: proxy('openai') + '/v1', OPENAI_API_KEY: g.handle })
    if (provider === 'gemini') Object.assign(env, { GOOGLE_GEMINI_BASE_URL: proxy('gemini'), GEMINI_API_KEY: g.handle })
  }
  return env
}

// What a session holds, safe to show or say: names and expiry, never handles.
export function grants(session) {
  return [...(held.get(session) || new Map())].map(([provider, g]) => ({ provider, secret: g.secret, expires: g.expires, grant: g.grant }))
}

export function forget(session) { held.delete(session) }

// Hook into agent.js and check porch now and then. One line in the wiring: vault.start().
export function start({ every = 15000, ...over } = {}) {
  deps = { ...deps, ...over }
  agent.onTaskEnv(envFor)
  if (!deps.url || !deps.token) return
  stop()
  timer = setInterval(() => poll().catch(() => {}), every)
  timer.unref?.()
}

export function stop() {
  if (timer) clearInterval(timer)
  timer = null
}
