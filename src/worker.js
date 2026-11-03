// anton-worker (npm run worker): the only process that runs Claude when WORKER=on.
// It owns the sessions, the task queue, long runs, the porch watcher, reflection,
// the liaison and the vault handles, and keeps them in work.db, so a restart of
// either process loses nothing: an interrupted task resumes its Claude
// conversation, a result is delivered after a restart, and notices for the phone
// wait in the outbox until Anton (npm start) is back.
// Local API on 127.0.0.1:WORKER_PORT, guarded by ANTON_HOME/worker.secret.
import http from 'node:http'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { config } from './config.js'
import { log } from './log.js'
import { query, listSessions, getSessionInfo } from './sdk.js'
import * as local from './agent.js'
import { use } from './runner.js'
import * as hub from './hub.js'
import * as longrun from './longrun.js'
import * as directory from './agents.js'
import * as reflection from './reflect.js'
import * as vault from './vault.js'
import * as memory from './memory.js'
import * as delivery from './deliver.js'
import { open, importLegacy, loadRuns, storeRuns, backup, workerSecret } from './workdb.js'
import { validSecret } from './worker-secret.js'

const HB = config.workerHeartbeatMs
const MAX_RESUMES = 3
const clip = local.clip
const sleep = ms => new Promise(r => setTimeout(r, ms))

let db = null
let secret = ''
let port = 0
let ready = false
let stopping = false
const live = new Map() // task id -> { abort, lastText, stopped, checkpoint, attempt }
const timers = []
let hooks = { agentPost: null, sessionsChanged: () => {} }

// Work done while handling a porch message or delivering a result gets keys from
// it (porch:<id>:0, d<task>:1, ...), so doing the same work again after a restart
// repeats nothing: a keyed task, notice or porch post happens once.
const als = new AsyncLocalStorage()
const keyed = (key, fn) => als.run({ key, n: 0 }, fn)
const unkeyed = fn => als.exit(fn)
function nextKey() {
  const c = als.getStore()
  return c ? `${c.key}:${c.n++}` : null
}

// A step of that work whose outcome decides what comes next (an answer to a
// permission, a stop, the list of waiting questions) is done once: done again, it
// gives back its first result without doing anything, and the keys after it line
// up with the first time, so the same replies follow and are not posted twice.
function once(fn) {
  const c = als.getStore()
  if (!c) return fn()
  const key = `${c.key}:${c.n++}`
  const seen = db.get('SELECT value, n FROM memo WHERE key = ?', key)
  if (seen) { c.n = seen.n; return JSON.parse(seen.value) }
  const save = out => { db.run('INSERT OR IGNORE INTO memo (key, value, n, at) VALUES (?, ?, ?, ?)', key, JSON.stringify(out ?? null), c.n, Date.now()); return out }
  // A step that only changes work.db is saved in the same transaction as its result.
  const out = db.tx(() => { const r = fn(); return r instanceof Promise ? r : save(r) })
  return out instanceof Promise ? out.then(save) : out
}

// Sessions

const display = t => clip(t.label || t.prompt, 300)
const sessionRow = name => name ? db.get('SELECT * FROM sessions WHERE name = ?', local.slug(name)) || null : null
const runningTask = name => db.get("SELECT * FROM tasks WHERE session = ? AND status = 'running' ORDER BY id DESC LIMIT 1", name)
const queuedFor = name => db.get("SELECT COUNT(*) AS n FROM tasks WHERE session = ? AND status = 'queued'", name).n
const deliverOf = t => { try { return JSON.parse(t.deliver_json) || { type: 'notify' } } catch { return { type: 'notify' } } }

// Linked porch agents run elsewhere, so they do not take a local slot.
function runningCount() {
  return db.get(`SELECT COUNT(*) AS n FROM tasks t JOIN sessions s ON s.name = t.session
    WHERE t.status = 'running' AND s.porch_agent IS NULL`).n
}

function ensureMain() {
  db.run(`INSERT OR IGNORE INTO sessions (name, purpose, dir, created, last_result) VALUES ('main', 'general tasks', ?, ?, '')`, config.workDir, new Date().toISOString())
}

// Permission rows still waiting, with the session each belongs to.
function pendingRows() {
  return db.all(`SELECT p.*, t.session FROM permissions p JOIN tasks t ON t.id = p.task
    WHERE p.status = 'pending' AND t.status IN ('running', 'queued', 'interrupted') ORDER BY p.id`)
}

function summary(s) {
  const t = runningTask(s.name)
  const waiting = pendingRows().find(p => p.session === s.name)
  return {
    name: s.name,
    purpose: s.purpose || '',
    folder: s.porch_agent ? null : s.dir,
    porchAgent: s.porch_agent || null,
    running: !!t,
    task: t ? display(t) : null,
    minutesRunning: t ? Math.round((Date.now() - t.started) / 60000) : 0,
    latestUpdate: clip(t && live.get(t.id)?.lastText, 600),
    lastResult: clip(s.last_result, 1500),
    waitingForPermission: waiting ? waiting.input_summary : null,
    queued: queuedFor(s.name),
    lastUsed: s.last_used || null,
  }
}

function list() {
  return db.all('SELECT * FROM sessions').sort((a, b) => (b.last_used || '').localeCompare(a.last_used || '')).map(summary)
}

function status(name) {
  if (name) {
    const s = sessionRow(name)
    return s ? summary(s) : { ok: false, reason: `No session named ${name}.` }
  }
  return { sessions: list(), workDir: config.workDir }
}

// One per session: the oldest question, which a yes or no answers first. id lets
// porch bind an answer to the question it saw (see answerPermission).
function pendingPermissions() {
  const bySession = new Map()
  for (const p of pendingRows()) if (!bySession.has(p.session)) bySession.set(p.session, { session: p.session, summary: p.input_summary, id: p.id })
  return [...bySession.values()]
}

function addSession(fields) {
  db.run(`INSERT INTO sessions (name, purpose, dir, fork_from, porch_agent, created, last_result) VALUES (?, ?, ?, ?, ?, ?, '')`,
    fields.name, fields.purpose || '', fields.dir || config.workDir, fields.forkFrom, fields.porchAgent, new Date().toISOString())
  hooks.sessionsChanged()
}

function createSession({ name, purpose, folder, newFolder = false }) {
  const n = local.slug(name)
  if (!n) return { ok: false, reason: 'The session needs a name.' }
  if (sessionRow(n)) return { ok: false, reason: `There is already a session named ${n}.` }
  const dir = local.folderFor(folder, { create: newFolder })
  if (!dir) return { ok: false, reason: `No folder called ${folder} near ${config.workDir}. Say the full path, or ask for a new folder (made inside ${config.workDir}).` }
  addSession({ name: n, purpose, dir })
  log(`session created: ${n} in ${dir}`)
  return { ok: true, name: n, folder: dir }
}

async function findClaudeSessions({ folder, limit = 8 } = {}) {
  const dir = folder ? local.folderFor(folder) : undefined
  const found = await listSessions({ dir, limit: Math.min(Number(limit) || 8, 20) })
  const taken = new Set(db.all('SELECT claude_session_id AS a, fork_from AS b FROM sessions').flatMap(r => [r.a, r.b]).filter(Boolean))
  return found.map(f => ({
    id: f.sessionId,
    title: clip(f.customTitle || f.summary || f.firstPrompt, 120),
    folder: f.cwd,
    lastActive: new Date(f.lastModified).toISOString(),
    alreadyAttached: taken.has(f.sessionId),
  }))
}

async function attachSession({ name, purpose, claudeSessionId }) {
  const n = local.slug(name)
  if (!n) return { ok: false, reason: 'The session needs a name.' }
  if (sessionRow(n)) return { ok: false, reason: `There is already a session named ${n}.` }
  const info = await getSessionInfo(claudeSessionId).catch(() => null)
  if (!info) return { ok: false, reason: 'No Claude Code session with that id on this laptop.' }
  const dir = info.cwd || config.workDir
  addSession({ name: n, purpose: purpose || clip(info.customTitle || info.summary, 120), dir, forkFrom: claudeSessionId })
  log(`session attached: ${n} continues ${String(claudeSessionId).slice(0, 8)}`)
  return { ok: true, name: n, folder: dir }
}

function linkAgent({ name, agent: porchAgent, purpose }) {
  const n = local.slug(name)
  const a = String(porchAgent || '').trim()
  if (!n || !a) return { ok: false, reason: 'Linking needs a session name and the porch agent name.' }
  if (!hooks.agentPost) return { ok: false, reason: 'Anton is not connected to porch.' }
  if (sessionRow(n)) return { ok: false, reason: `There is already a session named ${n}.` }
  addSession({ name: n, purpose: purpose || `the ${a} agent on porch`, porchAgent: a })
  log(`session linked: ${n} talks to ${a} on porch`)
  return { ok: true, name: n, agent: a }
}

function resetSession(name) {
  const s = sessionRow(name || 'main')
  if (!s) return { ok: false, reason: `No session named ${name}.` }
  if (s.porch_agent) return { ok: false, reason: `${s.name} is ${s.porch_agent} on porch. It keeps its own conversation.` }
  if (runningTask(s.name)) return { ok: false, reason: `${s.name} is still working. Stop it first.` }
  db.run("UPDATE sessions SET claude_session_id = NULL, fork_from = NULL, last_result = '' WHERE name = ?", s.name)
  return { ok: true, note: `${s.name} starts a fresh Claude conversation next time.` }
}

function removeSession(name) {
  const s = sessionRow(name)
  if (!s) return { ok: false, reason: `No session named ${name}.` }
  if (s.name === 'main') return { ok: false, reason: 'The main session cannot be removed. Reset it instead.' }
  if (runningTask(s.name)) return { ok: false, reason: `${s.name} is still working. Stop it first.` }
  db.run('DELETE FROM sessions WHERE name = ?', s.name)
  hooks.sessionsChanged(s.name)
  return { ok: true }
}

// Tasks

// Same rules as agent.js. deliver: what to do with the result (plain JSON). key:
// a task with the same key is made only once.
function ask(message, { session = 'main', label, queue = false, deliver, readOnly = false, fresh = false, key } = {}) {
  if (!String(message || '').trim()) return { ok: false, reason: 'The task is empty. Call again with the task written in message.' }
  key = key || nextKey()
  const seen = key && db.get('SELECT id, session FROM tasks WHERE key = ?', key)
  if (seen) return { ok: true, session: seen.session, task: seen.id }
  const s = sessionRow(session)
  if (!s) return { ok: false, reason: `No session named ${session}. Create it first.` }
  if (s.porch_agent) {
    const id = addTask(s, message, { label, deliver, readOnly, fresh, key })
    kick()
    return { ok: true, session: s.name, task: id, note: `Posted to ${s.porch_agent} on porch. Its reply comes back as an update.` }
  }
  const running = !!runningTask(s.name)
  const ahead = queuedFor(s.name)
  const busy = running || ahead > 0 || runningCount() >= config.maxRunning
  if (busy) {
    if (!queue) {
      return { ok: false, reason: running ? `${s.name} is still working on its last task. Stop it, wait, or use another session.` : ahead ? `${s.name} already has a task waiting. Wait for it, or use another session.` : `${config.maxRunning} sessions are already working. Wait for one to finish.` }
    }
    if (db.get("SELECT COUNT(*) AS n FROM tasks WHERE status = 'queued' AND resume = 0").n >= 10) return { ok: false, reason: 'Ten tasks are already waiting. Try again later.' }
  }
  const id = addTask(s, message, { label, deliver, readOnly, fresh, key })
  kick()
  return busy ? { ok: true, session: s.name, task: id, queued: ahead + 1 } : { ok: true, session: s.name, task: id }
}

function addTask(s, message, { label, deliver, readOnly, fresh, key }) {
  const r = db.run(`INSERT INTO tasks (key, session, prompt, label, read_only, fresh, status, created, deliver_json) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
    key, s.name, String(message), label ? clip(label, 300) : null, !!readOnly, !!fresh, Date.now(), JSON.stringify(deliver || { type: 'notify' }))
  const id = Number(r.lastInsertRowid)
  db.event('queued', id)
  return id
}

// Start what can start: resumed tasks first, then in order, up to MAX_RUNNING.
function pump() {
  if (!ready || stopping) return
  const busy = new Set(db.all("SELECT session FROM tasks WHERE status = 'running'").map(r => r.session))
  let slots = config.maxRunning - runningCount()
  for (const t of db.all("SELECT * FROM tasks WHERE status = 'queued' ORDER BY resume DESC, id")) {
    const s = sessionRow(t.session)
    if (!s) { failQueued(t, 'the session was removed'); continue }
    // The other agent keeps its own queue, so follow-ups go straight through.
    if (!s.porch_agent) {
      if (busy.has(s.name) || slots <= 0) continue
      slots--
      busy.add(s.name)
    }
    begin(t, s)
  }
}

function failQueued(t, why) {
  db.tx(() => {
    db.run("UPDATE tasks SET status = 'failed', error = ?, finished = ? WHERE id = ? AND status = 'queued'", why, Date.now(), t.id)
    db.event('failed', t.id, { why })
  })
}

function begin(t, s) {
  const now = Date.now()
  db.tx(() => {
    db.run("UPDATE tasks SET status = 'running', started = COALESCE(started, ?), heartbeat = ?, starts = starts + 1 WHERE id = ?", now, now, t.id)
    db.run('UPDATE sessions SET last_used = ? WHERE name = ?', new Date().toISOString(), s.name)
    db.event(t.resume ? 'restarted' : 'started', t.id)
  })
  log(`[${s.name}] task ${t.id} ${t.resume ? 'resumed' : 'started'}`)
  unkeyed(() => (s.porch_agent ? sendToAgent(t, s) : runClaude(t, s)).catch(err => log(`[${s.name}] task ${t.id}: ${err.message}`)))
}

const resumePrompt = t => `Your previous turn was interrupted by a restart. Continue from where you stopped and finish: ${display(t)}`

async function runClaude(t, s) {
  // start: which start of the task this is (begin counts them, kills and clean stops alike).
  const me = { abort: new AbortController(), lastText: '', stopped: false, checkpoint: false, start: (t.starts || 0) + 1 }
  live.set(t.id, me)
  // A resumed task continues its own conversation, even when it began fresh.
  const resuming = !!(t.resume && t.claude_session_id)
  const fresh = !!t.fresh
  let sid = t.claude_session_id
  let result = ''
  let failed = null
  try {
    const q = query({
      prompt: resuming ? resumePrompt(t) : t.prompt,
      options: local.taskOptions(s, {
        readOnly: !!t.read_only,
        resume: resuming ? t.claude_session_id : fresh ? undefined : s.claude_session_id || s.fork_from,
        fork: !resuming && !fresh && !s.claude_session_id && !!s.fork_from,
        canUseTool: canUseToolFor(t, s, me),
        abortController: me.abort,
      }),
    })
    for await (const msg of q) {
      // Recorded on the first message, so the task can always be resumed.
      if (msg.session_id && msg.session_id !== sid && !me.checkpoint) {
        sid = msg.session_id
        db.tx(() => {
          db.run('UPDATE tasks SET claude_session_id = ? WHERE id = ?', sid, t.id)
          db.run('UPDATE sessions SET claude_session_id = ?, fork_from = NULL WHERE name = ?', sid, s.name)
        })
      }
      if (msg.type === 'assistant') {
        const text = (msg.message?.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim()
        if (text) me.lastText = text
      } else if (msg.type === 'result') {
        if (msg.subtype === 'success' && !msg.is_error) result = msg.result || me.lastText
        else failed = msg.result || msg.subtype
      }
    }
  } catch (err) {
    failed = me.stopped ? 'stopped by the user' : String(err?.message || err)
  }
  live.delete(t.id)
  // Shutting down: the task was checkpointed and resumes on the next start.
  if (me.checkpoint || stopping) return
  finish(t.id, result, failed ? String(failed) : null)
}

function finish(id, result, failed) {
  const t = db.get('SELECT * FROM tasks WHERE id = ?', id)
  if (!t || t.status !== 'running') return
  const status = !failed ? 'done' : failed === 'stopped by the user' ? 'stopped' : 'failed'
  db.tx(() => {
    db.run('UPDATE tasks SET status = ?, finished = ?, result = ?, error = ? WHERE id = ?', status, Date.now(), result || '', failed, id)
    db.run('UPDATE sessions SET last_result = ? WHERE name = ?', clip(failed ? `The task ended early: ${failed}` : result, 1500), t.session)
    db.run("UPDATE permissions SET status = 'stale' WHERE task = ? AND status = 'pending'", id)
    db.event(status, id)
  })
  log(`[${t.session}] task ${id} ${failed ? 'failed' : 'done'}`)
  try { memory.logTask({ session: t.session, task: display(t), result, failed, source: deliverOf(t).type === 'notify' ? 'call' : 'porch' }) } catch {}
  kick()
}

// Queued tasks that will not start after all. They are delivered as stopped.
function stopQueued(ids) {
  if (!ids.length) return
  db.tx(() => {
    for (const id of ids) {
      if (!db.run("UPDATE tasks SET status = 'stopped', error = 'stopped by the user', finished = ? WHERE id = ? AND status = 'queued'", Date.now(), id).changes) continue
      db.run("UPDATE permissions SET status = 'stale' WHERE task = ? AND status = 'pending'", id)
      db.event('stopped', id)
    }
  })
  kick()
}

// A task interrupted by a restart and waiting for a slot to resume counts as
// working: stopping its session stops it before it starts again.
const resuming = name => db.all("SELECT id FROM tasks WHERE session = ? AND status = 'queued' AND resume = 1", name).map(r => r.id)

function stop(name) {
  const names = [...new Set(db.all("SELECT session FROM tasks WHERE status = 'running' OR (status = 'queued' AND resume = 1)").map(r => r.session))]
  const s = name ? sessionRow(name) : names.length === 1 ? sessionRow(names[0]) : null
  if (!s) return { ok: false, reason: name ? `No session named ${name}.` : names.length ? `Several sessions are working: ${names.join(', ')}. Say which.` : 'Nothing is running.' }
  const t = runningTask(s.name)
  if (!t) {
    const waiting = resuming(s.name)
    if (!waiting.length) return { ok: false, reason: `${s.name} is not working on anything.` }
    stopQueued(waiting)
    return { ok: true, session: s.name }
  }
  if (s.porch_agent) {
    porchPost({ dm: s.porch_agent, kind: 'note', text: 'Stop the task I sent you.' }, `task:${t.id}:stop`).catch(() => {})
    finish(t.id, '', 'stopped by the user')
    return { ok: true, session: s.name }
  }
  db.run("UPDATE permissions SET status = 'denied', decided = ?, note = 'The user stopped the task.' WHERE task = ? AND status = 'pending'", Date.now(), t.id)
  const me = live.get(t.id)
  if (me) { me.stopped = true; me.abort.abort() } else finish(t.id, '', 'stopped by the user')
  return { ok: true, session: s.name }
}

// Permissions: a row per question (one per tool call, so parallel calls each get
// their own). The task waits on its row; the answer comes by API (phone or porch).
// A resumed task that asks the same again waits on the same row, or takes an
// answer that came while the worker was down. An answer that already reached a
// turn is not given again: that turn may have run the tool, so the owner is asked
// once more, after a kill or a clean stop alike.
function canUseToolFor(t, s, me) {
  return async (tool, input = {}, { signal } = {}) => {
    const json = JSON.stringify(input)
    const summary = local.describe(tool, input)
    let row = db.get('SELECT * FROM permissions WHERE task = ? AND tool = ? AND input_json = ? ORDER BY id DESC LIMIT 1', t.id, tool, json)
    const usable = row && (row.status === 'pending' || (['allowed', 'denied'].includes(row.status) && row.used == null))
    if (usable) db.run('UPDATE permissions SET start = ? WHERE id = ?', me.start, row.id)
    else {
      row = db.tx(() => {
        // Questions from an earlier start that this one has not asked again are left behind.
        db.run("UPDATE permissions SET status = 'stale' WHERE task = ? AND status = 'pending' AND start < ?", t.id, me.start)
        const r = db.run("INSERT INTO permissions (task, tool, input_summary, input_json, status, created, start) VALUES (?, ?, ?, ?, 'pending', ?, ?)", t.id, tool, summary, json, Date.now(), me.start)
        return db.get('SELECT * FROM permissions WHERE id = ?', r.lastInsertRowid)
      })
      log(`[${s.name}] task ${t.id} asks permission for ${tool}`)
    }
    if (row.status === 'pending') notice({ kind: 'permission', session: s.name, text: `In the ${s.name} session, Claude is asking permission to ${summary}` }, { key: `perm:${row.id}` })
    return waitFor(row.id, signal, me)
  }
}

function waitFor(id, signal, me) {
  return new Promise(resolve => {
    let timer = null
    const done = answer => { clearInterval(timer); resolve(answer) }
    const check = () => {
      let p
      try { p = db.get('SELECT * FROM permissions WHERE id = ?', id) } catch { return }
      if (!p || p.status === 'pending') return
      // A question left behind is never answered: the call is refused, not left waiting.
      if (p.status === 'stale') return done({ behavior: 'deny', message: 'This question was dropped; ask again if it is still needed.' })
      db.run('UPDATE permissions SET used = ? WHERE id = ? AND used IS NULL', me.start, id)
      done(p.status === 'allowed' ? { behavior: 'allow', updatedInput: JSON.parse(p.input_json) } : { behavior: 'deny', message: p.note || 'The user said no.' })
    }
    timer = setInterval(check, 250)
    signal?.addEventListener('abort', () => done({ behavior: 'deny', message: 'Aborted.' }))
    check()
  })
}

// The oldest waiting question of the session is answered. only: the question ids
// the owner saw when answering (porch), so an answer never reaches a question
// asked after it.
function answerPermission(approve, note, name, only) {
  const ids = Array.isArray(only) ? new Set(only.map(Number)) : null
  const rows = pendingRows().filter(r => !ids || ids.has(r.id))
  const waiting = [...new Map(rows.map(r => [r.session, r])).values()]
  const s = name ? sessionRow(name) : waiting.length === 1 ? sessionRow(waiting[0].session) : null
  if (!s) return { ok: false, reason: waiting.length > 1 ? `Several sessions are waiting: ${waiting.map(p => `${p.session} (${p.input_summary})`).join('; ')}. Say which.` : ids ? 'That question is no longer waiting.' : 'No permission request is waiting.' }
  const p = rows.find(r => r.session === s.name)
  if (!p) return { ok: false, reason: `${s.name} is not waiting for permission.` }
  db.run("UPDATE permissions SET status = ?, decided = ?, note = ? WHERE id = ? AND status = 'pending'", approve ? 'allowed' : 'denied', Date.now(), approve ? null : note || 'The user said no.', p.id)
  log(`[${s.name}] permission ${approve ? 'approved' : 'denied'}: ${p.tool}`)
  return { ok: true, session: s.name }
}

// Linked porch agents: the task is posted to the agent, and its reply is the result.
async function sendToAgent(t, s) {
  // The agent keeps its own queue; as in agent.js, only the newest task is followed.
  db.run("UPDATE tasks SET status = 'stopped', error = 'replaced by a newer task', finished = ?, delivered = 1 WHERE session = ? AND status = 'running' AND id < ?", Date.now(), s.name, t.id)
  if (t.post_id) return
  log(`[${s.name}] task ${t.id} posted to ${s.porch_agent}`)
  try {
    const posted = await porchPost({ dm: s.porch_agent, kind: 'question', text: t.prompt }, `task:${t.id}:post`)
    db.run('UPDATE tasks SET post_id = ? WHERE id = ?', posted?.id ?? null, t.id)
  } catch (err) {
    finish(t.id, '', `could not post to porch: ${err.message}`)
  }
}

// A porch message from an agent a session stands for: addressed to Anton, or a
// reply in the task's thread. Returns true when it finished a task.
function agentReply(m, { forMe = true } = {}) {
  const t = db.get(`SELECT t.* FROM tasks t JOIN sessions s ON s.name = t.session
    WHERE s.porch_agent = ? AND t.status = 'running' ORDER BY t.id DESC LIMIT 1`, m.from)
  if (!t || !(forMe || (t.post_id && m.reply_to === t.post_id))) return false
  finish(t.id, String(m.text || ''), null)
  return true
}

// Delivery: each finished task's deliver_json is carried out until delivered = 1.
// Targets whose effects stay in work.db (notify, longrun) run in one transaction
// with the delivered mark. Porch ones are keyed (see porchPost), so a retry after a
// crash mid-delivery repeats nothing.

let delivering = false
let again = false
async function deliverAll() {
  if (!ready || stopping) return
  if (delivering) { again = true; return }
  delivering = true
  try {
    do {
      again = false
      const rows = db.all("SELECT * FROM tasks WHERE status IN ('done', 'failed', 'stopped') AND delivered = 0 AND deliver_after <= ? ORDER BY id", Date.now())
      for (const t of rows) {
        if (stopping) return
        await deliverOne(t)
      }
    } while (again && !stopping)
  } finally { delivering = false }
}

async function deliverOne(t) {
  const target = deliverOf(t)
  const failed = t.status === 'done' ? null : t.error || t.status
  try {
    if (delivery.LOCAL.has(target.type)) {
      db.tx(() => { deliverLocal(target, t, failed); markDelivered(t) })
    } else {
      await keyed(`d${t.id}`, () => delivery.run(target, t.result, failed))
      db.tx(() => markDelivered(t))
    }
  } catch (err) {
    if (stopping) return
    const tries = t.deliver_tries + 1
    db.run('UPDATE tasks SET deliver_tries = ?, deliver_after = ? WHERE id = ?', tries, Date.now() + Math.min(300e3, 1000 * 2 ** tries), t.id)
    log(`could not deliver the result of task ${t.id} (try ${tries}): ${clip(err.message, 200)}`)
  }
}

function markDelivered(t) {
  if (db.run('UPDATE tasks SET delivered = 1 WHERE id = ? AND delivered = 0', t.id).changes) db.event('delivered', t.id)
}

// The default: tell the phone and porch, in the same words as agent.js.
function deliverLocal(target, t, failed) {
  if (target.type === 'longrun') return longrun.deliver(target, t.result, failed)
  const s = sessionRow(t.session)
  const task = display(t)
  const key = `task:${t.id}`
  if (s?.porch_agent) {
    if (failed) notice({ kind: 'failed', session: t.session, task, text: `Could not reach ${s.porch_agent} for the ${t.session} session: ${clip(failed, 500)}` }, { key })
    else notice({ kind: 'done', session: t.session, task, text: `${s.porch_agent} replied in the ${t.session} session: ${clip(t.result, 3000)}` }, { key })
  } else if (failed) notice({ kind: 'failed', session: t.session, task, text: `In the ${t.session} session, Claude's task "${task}" ended early: ${clip(failed, 500)}` }, { key })
  else notice({ kind: 'done', session: t.session, task, text: `In the ${t.session} session, Claude finished "${task}". Its reply: ${clip(t.result, 3000)}` }, { key })
}

// Posts to porch with a key are made once. Before trying again after an unknown
// outcome (a crash, a timeout), porch is checked for the post.
async function porchPost(msg, key = nextKey()) {
  if (!key) return hub.rawPost(msg)
  const row = db.get('SELECT * FROM sent WHERE key = ?', key)
  if (row?.done) return { id: row.porch_id }
  if (row) {
    const found = await alreadyPosted(msg, row.started)
    if (found) {
      db.run('UPDATE sent SET done = 1, porch_id = ? WHERE key = ?', found.id, key)
      return found
    }
  } else db.run('INSERT INTO sent (key, started) VALUES (?, ?)', key, Date.now())
  const out = await hub.rawPost(msg)
  db.run('UPDATE sent SET done = 1, porch_id = ?, posts = posts + 1 WHERE key = ?', out?.id ?? null, key)
  return out
}

async function alreadyPosted(msg, since) {
  const q = { from: msg.as || hub.self(), limit: 50, room: msg.room, reply_to: msg.reply_to }
  const recent = await hub.list(q)
  return recent.find(m => m.text === msg.text && Date.parse(m.ts) >= since - 5000) || null
}

// The outbox: notices for the owner. The front gets them on its /notify; if it is
// down they wait. Porch relays go out from here.

function notice(n, { key, relay = true } = {}) {
  key = key || nextKey() || `n:${randomUUID()}`
  let added = false
  db.tx(() => {
    if (db.get('SELECT 1 FROM outbox WHERE key = ?', key)) return
    let ring = n.ring !== false
    let text = String(n.text || '')
    // A promised callback (call_me_back): hold results until the last one is in.
    const cb = db.meta('callback')
    const finishes = n.kind === 'done' || n.kind === 'failed'
    if (cb && finishes && cb.waiting.includes(n.session)) {
      cb.waiting = cb.waiting.filter(x => x !== n.session)
      if (cb.waiting.length) ring = false
      else text = `You asked me to call when this was done${cb.note ? ` (${cb.note})` : ''}. ${text}`
      db.meta('callback', cb.waiting.length ? cb : null)
    } else if (cb && n.kind !== 'permission') ring = false
    db.run('INSERT INTO outbox (key, kind, session, task, text, ring, relay, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      key, n.kind || 'note', n.session, n.task, text, ring, relay && hub.enabled, Date.now())
    added = true
  })
  if (added) { log(`update: ${n.kind}`); kickOutbox() }
}

function callBackWhenDone(sessions, note = '') {
  const waiting = [...new Set(sessions || [])]
  if (!waiting.length) return { ok: false, reason: 'Nothing is running, so there is nothing to wait for.' }
  db.meta('callback', { waiting, note: note || '' })
  log(`will call back when ${waiting.join(', ')} finish`)
  return { ok: true, waiting, note: `I will call when ${waiting.join(', ')} ${waiting.length > 1 ? 'have all' : 'has'} finished.` }
}

let sendingOutbox = false
async function sendOutbox() {
  if (!ready || stopping || sendingOutbox) return
  sendingOutbox = true
  try {
    const rows = db.all('SELECT * FROM outbox WHERE (sent = 0 OR (relay = 1 AND relayed = 0)) AND next_try <= ? ORDER BY id LIMIT 50', Date.now())
    for (const o of rows) {
      if (stopping) break
      if (o.relay && !o.relayed) {
        try {
          await porchPost(hub.relayMessage(o), `relay:${o.id}`)
          db.run('UPDATE outbox SET relayed = 1 WHERE id = ?', o.id)
        } catch (err) { later(o); continue }
      }
      if (!o.sent) {
        try {
          await toFront(o)
          db.run('UPDATE outbox SET sent = ? WHERE id = ?', Date.now(), o.id)
        } catch { later(o); break } // the front is down: everything waits
      }
    }
  } catch (err) {
    if (!stopping) log(`outbox: ${err.message}`)
  } finally { sendingOutbox = false }
}

function later(o) {
  db.run('UPDATE outbox SET tries = tries + 1, next_try = ? WHERE id = ?', Date.now() + Math.min(60e3, 1000 * 2 ** Math.min(o.tries, 6)), o.id)
}

async function toFront(o) {
  const r = await fetch(`http://127.0.0.1:${config.port}/notify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-worker-secret': secret },
    body: JSON.stringify({ outbox: `${db.meta('db_id')}:${o.id}`, notice: { kind: o.kind, session: o.session || undefined, task: o.task || undefined, text: o.text, ring: !!o.ring } }),
    signal: AbortSignal.timeout(5000),
  })
  if (!r.ok) throw new Error(`front answered ${r.status}`)
}

let outboxKick = null
function kickOutbox() {
  if (outboxKick) return
  outboxKick = setImmediate(() => { outboxKick = null; unkeyed(sendOutbox) })
}

let workKick = null
function kick() {
  if (workKick || !db) return
  workKick = setImmediate(() => { workKick = null; unkeyed(() => { pump(); deliverAll() }) })
}

// Restarts

// On start: any task still marked running belongs to a worker that died (only one
// runs at a time). It is marked interrupted and queued to continue its own Claude
// conversation. After MAX_RESUMES it fails, which reaches the owner through its
// delivery. A clean stop (checkpoint) does not count as an attempt.
function recover() {
  const now = Date.now()
  for (const t of db.all("SELECT * FROM tasks WHERE status = 'running'")) {
    if (sessionRow(t.session)?.porch_agent) continue // still waiting on the agent's reply
    db.tx(() => {
      db.run("UPDATE tasks SET status = 'interrupted' WHERE id = ?", t.id)
      db.event('interrupted', t.id, { heartbeat: t.heartbeat, clean: false })
    })
  }
  for (const t of db.all("SELECT * FROM tasks WHERE status = 'interrupted' ORDER BY id")) {
    const attempts = t.clean ? t.attempts : t.attempts + 1
    if (attempts > MAX_RESUMES) {
      db.tx(() => {
        db.run("UPDATE tasks SET status = 'failed', error = ?, finished = ?, attempts = ? WHERE id = ?", `it was interrupted by restarts ${attempts} times`, now, attempts, t.id)
        db.event('failed', t.id, { gaveUp: true })
      })
      log(`[${t.session}] task ${t.id} gave up after ${attempts} interruptions`)
      continue
    }
    db.tx(() => {
      db.run("UPDATE tasks SET status = 'queued', resume = 1, attempts = ?, clean = 0 WHERE id = ?", attempts, t.id)
      db.event('resumed', t.id, { latency: now - (t.heartbeat || now), clean: !!t.clean })
    })
    log(`[${t.session}] task ${t.id} will resume (attempt ${attempts})`)
  }
}

function hasOpenRound(session) {
  return !!db.get(`SELECT 1 FROM tasks WHERE session = ? AND deliver_json LIKE '%"type":"longrun"%'
    AND (status IN ('queued', 'running', 'interrupted') OR delivered = 0) LIMIT 1`, session)
}

let lastBeat = 0
function beat() {
  const now = Date.now()
  if (lastBeat && now - lastBeat > 3 * HB) db.event('heartbeat-gap', null, { ms: now - lastBeat })
  lastBeat = now
  for (const id of live.keys()) db.run('UPDATE tasks SET heartbeat = ? WHERE id = ?', now, id)
  db.meta('lock', { pid: process.pid, port, at: now })
}

// Stopping on purpose: running tasks reach a checkpoint (interrupted, cleanly) and
// resume on the next start.
async function shutdown(code = 0) {
  if (stopping) return
  stopping = true
  log('worker stopping; running tasks resume on the next start')
  const now = Date.now()
  for (const [id, me] of live) {
    me.checkpoint = true
    db.tx(() => {
      db.run("UPDATE tasks SET status = 'interrupted', clean = 1, heartbeat = ? WHERE id = ? AND status = 'running'", now, id)
      db.event('interrupted', id, { heartbeat: now, clean: true })
    })
    me.abort.abort()
  }
  for (let i = 0; i < 60 && (live.size || delivering || sendingOutbox); i++) await sleep(50)
  for (const t of timers) clearInterval(t)
  hub.stop()
  vault.stop()
  reflection.stop()
  server?.close()
  try { db.meta('lock', null) } catch {}
  db.close()
  rmSync(join(config.antonHome, 'worker.pid'), { force: true })
  process.exit(code)
}

// Metrics (GET /metrics, npm run worker-check)
function metrics() {
  const n = (sql, ...a) => db.get(sql, ...a).n
  const ev = kind => n('SELECT COUNT(*) AS n FROM events WHERE kind = ?', kind)
  const byStatus = s => n('SELECT COUNT(*) AS n FROM tasks WHERE status = ?', s)
  const round = `deliver_json LIKE '%"type":"longrun"%'`
  const latency = db.all("SELECT detail FROM events WHERE kind = 'resumed'").map(r => JSON.parse(r.detail || '{}').latency).filter(Number.isFinite)
  const orphans = db.all(`SELECT t.id, s.porch_agent FROM tasks t LEFT JOIN sessions s ON s.name = t.session WHERE t.status = 'running'`)
    .filter(r => !r.porch_agent && !live.has(r.id)).length
  const waiting = db.get('SELECT COUNT(*) AS n, MIN(created) AS oldest FROM outbox WHERE sent = 0')
  return {
    pid: process.pid,
    uptimeSeconds: Math.round(process.uptime()),
    tasks: {
      started: ev('started'), done: byStatus('done'), failed: byStatus('failed'), stopped: byStatus('stopped'),
      queued: byStatus('queued'), running: byStatus('running'), interrupted: ev('interrupted'), resumed: ev('resumed'),
    },
    rounds: {
      started: n(`SELECT COUNT(*) AS n FROM tasks WHERE ${round} AND started IS NOT NULL`),
      done: n(`SELECT COUNT(*) AS n FROM tasks WHERE ${round} AND status = 'done' AND delivered = 1`),
      failed: n(`SELECT COUNT(*) AS n FROM tasks WHERE ${round} AND status = 'failed'`),
    },
    runs: { active: n("SELECT COUNT(*) AS n FROM runs WHERE status = 'active'"), ended: n("SELECT COUNT(*) AS n FROM runs WHERE status = 'ended'") },
    // Interrupted and never resumed or finished. Must be 0.
    lost: byStatus('interrupted') + orphans,
    // A result delivered twice, or a porch post made twice. Must be 0.
    duplicates: n("SELECT COUNT(*) AS n FROM (SELECT task FROM events WHERE kind = 'delivered' GROUP BY task HAVING COUNT(*) > 1)") + n('SELECT COUNT(*) AS n FROM sent WHERE posts > 1'),
    undelivered: n("SELECT COUNT(*) AS n FROM tasks WHERE status IN ('done', 'failed', 'stopped') AND delivered = 0"),
    resumeLatencyMs: { count: latency.length, avg: latency.length ? Math.round(latency.reduce((a, b) => a + b, 0) / latency.length) : 0, max: latency.length ? Math.max(...latency) : 0 },
    outbox: { waiting: waiting.n, oldestSeconds: waiting.oldest ? Math.round((Date.now() - waiting.oldest) / 1000) : 0 },
    heartbeatGaps: ev('heartbeat-gap'),
  }
}

// The runner the rest of Anton talks to inside the worker (see runner.js).
const runner = {
  list, status, pendingPermissions, hasPendingPermission: () => pendingRows().length > 0,
  folderFor: local.folderFor, createSession, findClaudeSessions, attachSession, linkAgent, resetSession, removeSession,
  ask, stop, answerPermission, agentReply,
  onAgentPost: fn => { hooks.agentPost = fn },
  onSessionsChanged: fn => { hooks.sessionsChanged = fn },
  onNotify: () => {}, onFinish: () => {},
  setContext: fn => local.setContext(fn),
  onTaskEnv: fn => local.onTaskEnv(fn),
  childEnv: local.childEnv,
  SESSION_DENIED: local.SESSION_DENIED,
}

// The local API. The front's calls, by name; only these can be called.
const pickAsk = (o = {}) => ({ session: o.session, label: o.label, queue: !!o.queue })
const CALLS = {
  list, status, pendingPermissions, stop, answerPermission, createSession, findClaudeSessions, attachSession, linkAgent, resetSession, removeSession,
  ask: (message, o) => ask(message, pickAsk(o)),
  startRun: o => longrun.startRun(o || {}),
  stopRun: session => longrun.stopRun(session),
  runs: () => longrun.list(),
  listAgents: () => directory.listAgents(),
  askAgent: (name, message, o) => directory.askAgent(name, message, pickAsk(o)),
  agentWork: (name, o) => directory.agentWork(name, o || {}),
  callBackWhenDone,
  // A notice from the front (a script's /notify): to the phone and porch, like any other.
  notice: n => { notice({ kind: 'note', text: String(n?.text || '').slice(0, 2000) }); return { ok: true } },
}

function allowed(req) {
  // Tunnels and proxies add these; a direct local request has none.
  if (['x-forwarded-for', 'cf-connecting-ip', 'forwarded', 'x-real-ip'].some(h => req.headers[h])) return false
  const a = req.socket.remoteAddress
  if (a !== '127.0.0.1' && a !== '::ffff:127.0.0.1') return false
  // An empty or broken key is no key: nothing gets in.
  if (!validSecret(secret)) return false
  // A web page can send a plain POST to localhost without asking; it cannot set JSON.
  if (req.method === 'POST' && !/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return false
  const got = Buffer.from(String(req.headers['x-worker-secret'] || ''))
  const want = Buffer.from(secret)
  return got.length === want.length && timingSafeEqual(got, want)
}

async function handle(req, res) {
  const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
  if (!allowed(req)) return send(403, { error: 'forbidden' })
  const url = new URL(req.url, 'http://localhost')
  if (req.method === 'GET' && url.pathname === '/health') return send(200, { ok: true, pid: process.pid, ready })
  if (!ready) return send(503, { error: 'starting' })
  try {
    if (req.method === 'GET' && url.pathname === '/state') return send(200, { sessions: list(), pending: pendingPermissions(), runs: longrun.list(), workDir: config.workDir })
    if (req.method === 'GET' && url.pathname === '/metrics') return send(200, metrics())
    if (req.method === 'POST' && url.pathname === '/shutdown') { send(200, { ok: true }); return shutdown(0) }
    if (req.method === 'POST' && url.pathname === '/call') {
      const { fn, args = [] } = JSON.parse(await readBody(req) || '{}')
      if (!Object.hasOwn(CALLS, fn)) return send(404, { error: 'unknown call' })
      // JSON turns a missing argument into null; give it back as undefined so defaults apply.
      return send(200, { result: await CALLS[fn](...(Array.isArray(args) ? args : []).map(a => a ?? undefined)) ?? null })
    }
    send(404, { error: 'not found' })
  } catch (err) {
    log(`worker api: ${clip(err.message, 200)} (${clip(String(err.stack || '').split('\n')[1]?.trim(), 120)})`)
    send(500, { error: 'failed' })
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', c => { data += c; if (data.length > 1e6) { req.destroy(); reject(new Error('too big')) } })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

let server = null
function listen() {
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => handle(req, res).catch(() => {}))
    server.once('error', reject)
    server.listen(config.workerPort, '127.0.0.1', () => resolve(server.address().port))
  })
}

const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }

// The lock row in work.db: { pid, port, at }, written by beat(). It holds only
// while it is recent (an `at` in the future means the clock moved back), its pid
// is alive, and a worker with that pid answers on its port (pids get reused).
const recent = lock => { const age = Date.now() - lock.at; return age < 3 * HB && age > -HB }
async function answers(lock) {
  try {
    const r = await fetch(`http://127.0.0.1:${lock.port}/health`, { headers: { 'x-worker-secret': secret }, signal: AbortSignal.timeout(2000) })
    return r.ok && (await r.json()).pid === lock.pid
  } catch { return false }
}

// Returns the lock another worker holds, or null once this one holds it. The last
// check and the write are one transaction.
async function takeLock() {
  const lock = db.meta('lock')
  const held = lock && lock.pid !== process.pid && recent(lock) && alive(lock.pid) && await answers(lock)
  if (held) return lock
  return db.tx(() => {
    const now = db.meta('lock')
    if (now && now.pid !== process.pid && JSON.stringify(now) !== JSON.stringify(lock) && recent(now)) return now
    beat()
    return null
  })
}

// work.db was damaged and replaced (see workdb.js): the work in flight in the copy
// is settled without doing it again, and the owner is told.
function settleRestored({ from, kept }) {
  const now = Date.now()
  db.tx(() => {
    db.run("UPDATE tasks SET status = 'failed', error = 'work.db was restored from a backup', finished = ?, delivered = 1 WHERE status IN ('queued', 'running', 'interrupted')", now)
    db.run('UPDATE tasks SET delivered = 1 WHERE delivered = 0')
    db.run("UPDATE permissions SET status = 'stale' WHERE status = 'pending'")
    db.run('UPDATE outbox SET sent = ?, relayed = 1 WHERE sent = 0 OR relayed = 0', now)
    db.meta('callback', null)
  })
  const runs = loadRuns(db).map(r => r.session)
  const day = from ? /\d{4}-\d{2}-\d{2}/.exec(from)[0] : null
  log(`work.db was damaged; set aside as ${kept}, ${from ? `restored from backups/${from}` : 'no backup to restore, starting empty'}`)
  notice({
    kind: 'note',
    text: from
      ? `The worker's database was damaged, so it started again from the copy made on ${day}. Sessions are as they were then; tasks that were in flight are dropped.${runs.length ? ` Long runs that were going then are going again: ${runs.join(', ')}. Stop any that should not be.` : ''} The damaged file is kept in ANTON_HOME as ${kept}.`
      : `The worker's database was damaged and there was no copy to go back to, so it started empty. Sessions and long runs need setting up again. The damaged file is kept in ANTON_HOME as ${kept}.`,
  })
}
const phone = () => !!(config.twilioSid && config.twilioToken && config.twilioNumber && config.myNumber && config.openaiKey)

async function startHub() {
  try {
    await hub.start(phone() ? n => notice(n, { relay: false }) : null, { durable: true, around: (m, fn) => keyed(`porch:${m.id}`, fn), once })
    vault.start()
    // Linked-agent tasks whose post never went out (a crash right before it).
    for (const t of db.all("SELECT t.* FROM tasks t JOIN sessions s ON s.name = t.session WHERE t.status = 'running' AND s.porch_agent IS NOT NULL AND t.post_id IS NULL")) {
      sendToAgent(t, sessionRow(t.session)).catch(() => {})
    }
  } catch (err) {
    log(`porch: ${err.message}; trying again in 30 s`)
    setTimeout(startHub, 30e3).unref()
  }
}

// Porch messages are never handled again after a week, so their memo can go.
function prune() {
  try { db.run('DELETE FROM memo WHERE at < ?', Date.now() - 7 * 86400e3) } catch {}
}

export async function main() {
  process.on('unhandledRejection', err => log(`worker: ${clip(err?.message || err, 200)}`))
  secret = workerSecret(config.antonHome)
  if (!validSecret(secret)) throw new Error('ANTON_HOME/worker.secret is not a valid key')
  // The port is the lock: a second worker cannot bind it and leaves.
  try { port = await listen() } catch (err) {
    if (err.code === 'EADDRINUSE') { log(`another worker is already running on port ${config.workerPort}`); process.exit(0) }
    throw err
  }
  db = open(config.antonHome)
  const lock = await takeLock()
  if (lock) {
    log(`another worker (pid ${lock.pid}) holds work.db; leaving`)
    process.exit(0)
  }
  writeFileSync(join(config.antonHome, 'worker.port'), String(port))
  writeFileSync(join(config.antonHome, 'worker.pid'), String(process.pid))
  if (!db.meta('db_id')) db.meta('db_id', randomUUID())
  const imported = importLegacy(db)
  if (imported.sessions || imported.runs) log(`imported ${imported.sessions} session(s) and ${imported.runs} long run(s) into work.db`)
  if (imported.stale.length) log(`${imported.stale.join(' and ')} changed after the import into work.db (Anton ran without the worker since); the worker does not read them, so those changes are not in work.db`)
  if (db.restored) settleRestored(db.restored)
  ensureMain()
  try { backup(db) } catch (err) { log(`backup failed: ${err.message}`) }

  use(runner)
  local.setContext(() => memory.context({ calls: false }))
  longrun.setDeps({
    ask: (prompt, opts) => ask(prompt, opts),
    notify: n => notice(n),
    store: { load: () => loadRuns(db), save: runs => storeRuns(db, runs) },
    durable: true,
    openRound: hasOpenRound,
    // A stopped run's round that has not started yet does not run at all.
    dropRounds: session => stopQueued(db.all(`SELECT id FROM tasks WHERE session = ? AND status = 'queued' AND deliver_json LIKE '%"type":"longrun"%'`, session).map(r => r.id)),
    later: (fn, ms) => setTimeout(() => unkeyed(fn), ms),
    next: (fn, ms) => setTimeout(() => unkeyed(fn), ms),
  })
  hub.onPost(msg => porchPost(msg))

  recover()
  ready = true
  // Runs are loaded before anything is delivered, so no round result is dropped.
  longrun.resume()
  if (hub.enabled) await startHub()
  reflection.start()

  timers.push(setInterval(beat, HB))
  timers.push(setInterval(() => { pump(); deliverAll() }, 2000))
  timers.push(setInterval(sendOutbox, 2000))
  timers.push(setInterval(() => { try { backup(db) } catch {} prune() }, 3600e3))
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => shutdown(0))
  kick()
  kickOutbox()
  log(`worker ready on 127.0.0.1:${port} (pid ${process.pid})`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => { log(`worker failed to start: ${err.message}`); process.exit(1) })
}
