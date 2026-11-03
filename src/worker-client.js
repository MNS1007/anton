// The front's way to the worker (WORKER=on): the same function names agent.js
// exports, over the worker's local API with the secret in ANTON_HOME. Reads
// (list, status, pending permissions) come from a copy of the worker's state that
// is refreshed every few seconds and after every change, so they stay synchronous
// like agent.js. Changes return promises; tools.js awaits them.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './config.js'
import { workerSecret } from './worker-secret.js'

const DOWN = 'The worker that runs Claude is not answering right now. It is being restarted; try again in a minute.'
let state = { sessions: [], pending: [], runs: [], workDir: config.workDir }
let timer = null

// The port the worker wrote when it started (WORKER_PORT=0 picks a free one).
export function port() {
  try { return Number(readFileSync(join(config.antonHome, 'worker.port'), 'utf8')) || config.workerPort } catch { return config.workerPort }
}

async function api(path, body, timeout = 15000) {
  const r = await fetch(`http://127.0.0.1:${port()}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'x-worker-secret': workerSecret(config.antonHome) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  })
  if (!r.ok) throw new Error(`worker answered ${r.status}`)
  return r.json()
}

async function call(fn, ...args) {
  try {
    const { result } = await api('/call', { fn, args })
    await refresh()
    return result
  } catch {
    return { ok: false, reason: DOWN }
  }
}

export async function refresh() {
  try { state = await api('/state', undefined, 5000) } catch {}
  return state
}

export async function health() {
  try { return (await api('/health', undefined, 3000)).ok === true } catch { return false }
}

export const metrics = () => api('/metrics', undefined, 5000)
export const shutdown = () => api('/shutdown', {}, 5000)

export function start({ every = 2000 } = {}) {
  clearInterval(timer)
  timer = setInterval(refresh, every)
  timer.unref?.()
  return refresh()
}

// Reads, from the copy.
export const list = () => state.sessions
export function status(name) {
  if (!name) return { sessions: state.sessions, workDir: state.workDir }
  const n = String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return state.sessions.find(s => s.name === n) || { ok: false, reason: `No session named ${name}.` }
}
export const pendingPermissions = () => state.pending
export const hasPendingPermission = () => state.pending.length > 0

// Changes, in the worker.
export const ask = (message, opts = {}) => call('ask', message, opts)
export const stop = name => call('stop', name)
export const answerPermission = (approve, note, name) => call('answerPermission', approve, note, name)
export const createSession = fields => call('createSession', fields)
export const findClaudeSessions = async (opts = {}) => { const r = await call('findClaudeSessions', opts); return Array.isArray(r) ? r : [] }
export const attachSession = fields => call('attachSession', fields)
export const linkAgent = fields => call('linkAgent', fields)
export const resetSession = name => call('resetSession', name)
export const removeSession = name => call('removeSession', name)
export const callBackWhenDone = (sessions, note) => call('callBackWhenDone', sessions, note)
export const notice = n => call('notice', n)

export const longrun = {
  startRun: opts => call('startRun', opts),
  stopRun: session => call('stopRun', session),
  list: () => state.runs,
}

export const agents = {
  listAgents: async () => { const r = await call('listAgents'); return r?.agents ? r : { agents: state.sessions.map(s => ({ name: s.name, kind: 'Claude Code session on the laptop, run by Anton', purpose: s.purpose })) } },
  askAgent: (name, message, opts) => call('askAgent', name, message, opts),
  agentWork: (name, opts) => call('agentWork', name, opts),
}

// The worker owns these; the front has nothing to hook in.
export const agentReply = () => false
export function onNotify() {}
export function onSessionsChanged() {}
export function onFinish() {}
export function setContext() {}
export function onTaskEnv() {}
export function onAgentPost() {}
