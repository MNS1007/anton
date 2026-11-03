// work.db: the worker's source of truth, in ANTON_HOME (node:sqlite, WAL mode).
// sessions.json and runs.json are imported once and then left as backups.
// A copy of the db goes to ANTON_HOME/backups once a day, and a damaged db is set
// aside and replaced by the newest good copy.
import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Times are milliseconds since 1970, except the sessions' created and last_used,
// which keep the ISO strings sessions.json had.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  name TEXT PRIMARY KEY, purpose TEXT, dir TEXT, claude_session_id TEXT, fork_from TEXT,
  porch_agent TEXT, created TEXT, last_used TEXT, last_result TEXT);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT UNIQUE, session TEXT, prompt TEXT, label TEXT,
  read_only INTEGER DEFAULT 0, fresh INTEGER DEFAULT 0, status TEXT, claude_session_id TEXT,
  attempts INTEGER DEFAULT 0, created INTEGER, started INTEGER, heartbeat INTEGER, finished INTEGER,
  result TEXT, error TEXT, deliver_json TEXT, delivered INTEGER DEFAULT 0,
  deliver_tries INTEGER DEFAULT 0, deliver_after INTEGER DEFAULT 0,
  post_id INTEGER, resume INTEGER DEFAULT 0, clean INTEGER DEFAULT 0, starts INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status);
CREATE TABLE IF NOT EXISTS permissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task INTEGER, tool TEXT, input_summary TEXT, input_json TEXT,
  status TEXT, created INTEGER, decided INTEGER, note TEXT, used INTEGER, start INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS runs (
  session TEXT PRIMARY KEY, goal TEXT, until INTEGER, rounds INTEGER, started INTEGER, notes TEXT,
  last TEXT, max_rounds INTEGER, stop_early INTEGER, idle INTEGER, stamp TEXT, asks TEXT,
  asks_at INTEGER, status TEXT, failures INTEGER, next_at INTEGER);
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT UNIQUE, kind TEXT, session TEXT, task TEXT,
  text TEXT, ring INTEGER, relay INTEGER, created INTEGER, sent INTEGER DEFAULT 0,
  relayed INTEGER DEFAULT 0, tries INTEGER DEFAULT 0, next_try INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS events (ts INTEGER, kind TEXT, task INTEGER, detail TEXT);
CREATE INDEX IF NOT EXISTS events_kind ON events(kind);
CREATE TABLE IF NOT EXISTS sent (key TEXT PRIMARY KEY, started INTEGER, done INTEGER DEFAULT 0, porch_id INTEGER, posts INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS memo (key TEXT PRIMARY KEY, value TEXT, n INTEGER, at INTEGER);
`

// Columns added after the first version, for a work.db made before them.
const ADDED = { tasks: ['starts INTEGER DEFAULT 0'], permissions: ['start INTEGER DEFAULT 0'] }
function addColumns(raw) {
  for (const [table, cols] of Object.entries(ADDED)) {
    const have = new Set(raw.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name))
    for (const c of cols) if (!have.has(c.split(' ')[0])) raw.exec(`ALTER TABLE ${table} ADD COLUMN ${c}`)
  }
}

// node:sqlite refuses undefined and booleans: make every value bindable.
const bind = v => v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v

const BACKUP = /^work-\d{4}-\d{2}-\d{2}\.db$/
const DB_FILES = ['work.db', 'work.db-wal', 'work.db-shm']
// SQLITE_CORRUPT and SQLITE_NOTADB, or a failed check.
const damaged = err => [11, 26].includes(err?.errcode) || /not a database|malformed|failed its check/i.test(String(err?.message))

// When work.db was damaged, db.restored says what happened: from is the backup
// used (null when there was none and the db starts empty), kept is the name the
// damaged file was set aside under.
export function open(home) {
  mkdirSync(home, { recursive: true })
  try { return connect(home) } catch (err) {
    if (!damaged(err)) throw err
    const restored = restore(home)
    const db = connect(home)
    db.restored = { ...restored, why: String(err.message) }
    return db
  }
}

function connect(home) {
  const raw = new DatabaseSync(join(home, 'work.db'))
  try {
    raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;')
    const check = Object.values(raw.prepare('PRAGMA quick_check').get() || {})[0]
    if (check !== 'ok') throw new Error(`work.db failed its check: ${check}`)
    raw.exec(SCHEMA)
    addColumns(raw)
  } catch (err) {
    try { raw.close() } catch {}
    throw err
  }
  return wrap(raw, home)
}

// The damaged files are set aside (kept for a look later) and the newest backup
// that opens takes their place. With none, work.db starts empty.
function restore(home) {
  const kept = `work.db.corrupt-${Date.now()}`
  for (const f of DB_FILES) if (existsSync(join(home, f))) renameSync(join(home, f), join(home, f.replace('work.db', kept)))
  const dir = join(home, 'backups')
  const copies = existsSync(dir) ? readdirSync(dir).filter(f => BACKUP.test(f)).sort().reverse() : []
  for (const f of copies) {
    try {
      copyFileSync(join(dir, f), join(home, 'work.db'))
      connect(home).close()
      return { from: f, kept }
    } catch {
      for (const x of DB_FILES) rmSync(join(home, x), { force: true })
    }
  }
  return { from: null, kept }
}

function wrap(raw, home) {
  const cache = new Map()
  const stmt = sql => cache.get(sql) || cache.set(sql, raw.prepare(sql)).get(sql)
  let depth = 0
  const db = {
    raw,
    home,
    run: (sql, ...a) => stmt(sql).run(...a.map(bind)),
    get: (sql, ...a) => stmt(sql).get(...a.map(bind)),
    all: (sql, ...a) => stmt(sql).all(...a.map(bind)),
    // One transaction, even when called inside another.
    tx(fn) {
      if (depth) { depth++; try { return fn() } finally { depth-- } }
      raw.exec('BEGIN IMMEDIATE')
      depth = 1
      try {
        const out = fn()
        raw.exec('COMMIT')
        return out
      } catch (err) {
        raw.exec('ROLLBACK')
        throw err
      } finally { depth = 0 }
    },
    meta(key, value) {
      if (value === undefined) {
        const r = stmt('SELECT value FROM meta WHERE key = ?').get(key)
        return r ? JSON.parse(r.value) : null
      }
      if (value === null) return stmt('DELETE FROM meta WHERE key = ?').run(key)
      stmt('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value))
    },
    event(kind, task = null, detail = null) {
      stmt('INSERT INTO events (ts, kind, task, detail) VALUES (?, ?, ?, ?)').run(Date.now(), kind, bind(task), detail == null ? null : JSON.stringify(detail))
    },
    close() { try { raw.close() } catch {} },
  }
  return db
}

// First start: bring in what the in-process Anton saved. The files stay as they are.
// The mark that this was done is kept in work.db and in ANTON_HOME/work.imported,
// so a lost or replaced work.db never brings back old sessions or stopped runs.
// stale: files that changed after the import (the in-process Anton ran since), so
// what it saved there is not in work.db.
export function importLegacy(db) {
  const marker = join(db.home, 'work.imported')
  const done = db.meta('imported') || readJson(marker)
  if (done) {
    if (!existsSync(marker)) writeFileSync(marker, JSON.stringify(done))
    const stale = ['sessions.json', 'runs.json'].filter(f => { try { return statSync(join(db.home, f)).mtimeMs > done.at } catch { return false } })
    return { sessions: 0, runs: 0, stale }
  }
  const read = f => { try { return JSON.parse(readFileSync(join(db.home, f), 'utf8')) } catch { return [] } }
  let sessions = 0
  let runs = 0
  db.tx(() => {
    for (const s of read('sessions.json')) {
      if (!s?.name) continue
      sessions += db.run(`INSERT OR IGNORE INTO sessions (name, purpose, dir, claude_session_id, fork_from, porch_agent, created, last_used, last_result)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, s.name, s.purpose || '', s.dir, s.claudeSessionId, s.forkFrom, s.porchAgent, s.created, s.lastUsed, s.lastResult || '').changes
    }
    for (const r of read('runs.json')) {
      if (!r?.session) continue
      runs += saveRun(db, r, 'OR IGNORE').changes
    }
    db.meta('imported', { at: Date.now(), sessions, runs })
  })
  writeFileSync(marker, JSON.stringify(db.meta('imported')))
  return { sessions, runs, stale: [] }
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

// A long run as longrun.js keeps it, in and out of the runs table.
export function saveRun(db, r, mode = 'OR REPLACE') {
  return db.run(`INSERT ${mode} INTO runs (session, goal, until, rounds, started, notes, last, max_rounds, stop_early, idle, stamp, asks, asks_at, status, failures, next_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
  r.session, r.goal, r.until, r.rounds || 0, r.started, r.notes, r.last || '', r.maxRounds, !!r.stopEarly, r.idle || 0, r.stamp || null, r.asks || null, r.asksAt || null, r.failures || 0, r.nextAt || null)
}

export function loadRuns(db) {
  return db.all("SELECT * FROM runs WHERE status = 'active'").map(r => ({
    session: r.session, goal: r.goal, until: r.until, rounds: r.rounds, started: r.started, notes: r.notes, last: r.last || '',
    maxRounds: r.max_rounds, stopEarly: !!r.stop_early, idle: r.idle || 0, stamp: r.stamp || undefined, asks: r.asks || undefined,
    asksAt: r.asks_at || undefined, failures: r.failures || 0, nextAt: r.next_at || undefined,
  }))
}

// Every active run, written at once; a run no longer in the list has ended.
export function storeRuns(db, list) {
  db.tx(() => {
    for (const r of list) saveRun(db, r)
    const keep = new Set(list.map(r => r.session))
    for (const { session } of db.all("SELECT session FROM runs WHERE status = 'active'")) {
      if (!keep.has(session)) db.run("UPDATE runs SET status = 'ended' WHERE session = ?", session)
    }
  })
}

// A copy of work.db once a day, in ANTON_HOME/backups. Keeps the last 7. The copy
// is made under a .tmp name and renamed once complete, so a kill mid-copy never
// leaves a broken backup; a .tmp left behind by one is removed.
export function backup(db, now = new Date()) {
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const dir = join(db.home, 'backups')
  mkdirSync(dir, { recursive: true })
  for (const f of readdirSync(dir).filter(f => f.endsWith('.tmp'))) rmSync(join(dir, f), { force: true })
  if (db.meta('backup_day') === day) return null
  const file = join(dir, `work-${day}.db`)
  const tmp = `${file}.tmp`
  db.raw.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`)
  if (existsSync(file)) rmSync(file)
  renameSync(tmp, file)
  db.meta('backup_day', day)
  const old = readdirSync(dir).filter(f => BACKUP.test(f)).sort().slice(0, -7)
  for (const f of old) rmSync(join(dir, f), { force: true })
  return file
}

// The worker's API key lives in worker-secret.js, which the front can load without sqlite.
export { workerSecret } from './worker-secret.js'
