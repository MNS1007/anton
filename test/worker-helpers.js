// Helpers for the worker tests: a temp ANTON_HOME, free ports, a worker (and the
// front) in their own processes with the stub SDK, and the worker's API.
// Children get a small, explicit env and run in the temp folder, so they never
// read Anton's real .env or ~/.anton, and never reach porch, Twilio or OpenAI.
import { spawn } from 'node:child_process'
import { mkdtempSync, openSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'
import net from 'node:net'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
export const WORKER = join(root, 'src', 'worker.js')
export const FRONT = join(root, 'src', 'index.js')
export const STUB = join(root, 'test', 'fixtures', 'stub-sdk.js')
export const sleep = ms => new Promise(r => setTimeout(r, ms))

export const tempHome = () => mkdtempSync(join(tmpdir(), 'anton-worker-test-'))

export function freePort() {
  return new Promise(res => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) })
  })
}

// Only what Node needs to run, plus the test's settings.
export function childEnv(extra) {
  const keep = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE']
  const env = {}
  for (const k of keep) if (process.env[k]) env[k] = process.env[k]
  return {
    ...env,
    USER_NAME: 'Sam',
    REFLECT_HOURS: '0',
    LONG_RUN_GAP_MINUTES: '0',
    WORKER_HEARTBEAT_MS: '300',
    WORKER_CHECK_MS: '500',
    PORCH_CALL_ON: 'none',
    SET_WEBHOOK: 'false',
    ANTON_TEST_SDK: STUB,
    ...extra,
  }
}

export function startWorker(home, env) {
  const out = openSync(join(home, 'worker.log'), 'a')
  const child = spawn(process.execPath, [WORKER], { cwd: home, env: childEnv({ ANTON_HOME: home, WORK_DIR: home, ...env }), stdio: ['ignore', out, out], windowsHide: true })
  child.exited = new Promise(r => child.once('exit', code => r(code)))
  return child
}

export const secret = home => readFileSync(join(home, 'worker.secret'), 'utf8').trim()
const workerPort = home => Number(readFileSync(join(home, 'worker.port'), 'utf8'))

export async function api(home, path, body, headers = {}) {
  const r = await fetch(`http://127.0.0.1:${workerPort(home)}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'x-worker-secret': secret(home), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  })
  return { status: r.status, body: await r.json().catch(() => null) }
}

export const call = async (home, fn, ...args) => (await api(home, '/call', { fn, args })).body?.result

export async function until(fn, { timeout = 20000, every = 100, what = 'condition' } = {}) {
  const end = Date.now() + timeout
  for (;;) {
    try { const v = await fn(); if (v) return v } catch {}
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(every)
  }
}

// Ready: the API answers with this home's secret and the worker says it is ready.
export async function workerUp(home, pid) {
  return until(async () => {
    if (!existsSync(join(home, 'worker.port'))) return false
    const r = await api(home, '/health')
    return r.status === 200 && r.body.ready && (!pid || r.body.pid === pid) && r.body
  }, { what: 'the worker' })
}

export const metrics = async home => (await api(home, '/metrics')).body

// A stand-in for the front's /notify: records the worker's notices. down: refuse them.
export function fakeFront(port) {
  const front = { notices: [], down: false }
  front.server = http.createServer((req, res) => {
    let b = ''
    req.on('data', c => { b += c })
    req.on('end', () => {
      if (front.down) { res.writeHead(503); return res.end() }
      try { front.notices.push(JSON.parse(b)) } catch {}
      res.writeHead(200)
      res.end('ok')
    })
  })
  front.ready = new Promise(r => front.server.listen(port, '127.0.0.1', r))
  return front
}

export function kill(child) {
  try { process.kill(typeof child === 'number' ? child : child.pid) } catch {}
}

// Read work.db once the worker has exited; peekDb reads it while one runs (WAL
// lets a reader in).
export const readDb = (home, opts = {}) => {
  return import('node:sqlite').then(({ DatabaseSync }) => {
    const db = new DatabaseSync(join(home, 'work.db'), opts)
    try { return { tasks: db.prepare('SELECT * FROM tasks ORDER BY id').all(), events: db.prepare('SELECT * FROM events').all(), permissions: db.prepare('SELECT * FROM permissions ORDER BY id').all(), outbox: db.prepare('SELECT * FROM outbox').all(), sent: db.prepare('SELECT * FROM sent').all() } } finally { db.close() }
  })
}
export const peekDb = home => readDb(home, { readOnly: true })

// A change to work.db made while no worker runs.
export async function writeDb(home, fn) {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(home, 'work.db'))
  try { return fn(db) } finally { db.close() }
}
