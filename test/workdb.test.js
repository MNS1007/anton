import './setup.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { open, importLegacy, loadRuns, storeRuns, backup, workerSecret } from '../src/workdb.js'

const home = () => mkdtempSync(join(tmpdir(), 'anton-workdb-'))

test('work.db opens in WAL mode with every table', () => {
  const db = open(home())
  assert.equal(db.get('PRAGMA journal_mode').journal_mode, 'wal')
  const tables = db.all("SELECT name FROM sqlite_master WHERE type = 'table'").map(r => r.name)
  for (const t of ['sessions', 'tasks', 'permissions', 'runs', 'outbox', 'events', 'sent', 'meta']) assert.ok(tables.includes(t), t)
  db.close()
})

test('sessions.json and runs.json are imported once and the files are left as they are', () => {
  const h = home()
  const sessions = [{ name: 'main', purpose: 'general', dir: h, claudeSessionId: 'abc', created: '2026-11-01T00:00:00Z', lastUsed: '2026-11-02T00:00:00Z', lastResult: 'ok' },
    { name: 'renfort', porchAgent: 'renfort-claude', dir: h }]
  const runs = [{ session: 'main', goal: 'research', until: Date.now() + 3600e3, rounds: 4, started: Date.now() - 3600e3, notes: join(h, 'n.md'), last: 'step', maxRounds: 200, stopEarly: false, idle: 1 }]
  writeFileSync(join(h, 'sessions.json'), JSON.stringify(sessions))
  writeFileSync(join(h, 'runs.json'), JSON.stringify(runs))
  const db = open(h)
  assert.deepEqual(importLegacy(db), { sessions: 2, runs: 1, stale: [] })
  assert.deepEqual(importLegacy(db), { sessions: 0, runs: 0, stale: [] }, 'only once')
  const main = db.get("SELECT * FROM sessions WHERE name = 'main'")
  assert.equal(main.claude_session_id, 'abc')
  assert.equal(db.get("SELECT porch_agent FROM sessions WHERE name = 'renfort'").porch_agent, 'renfort-claude')
  const [r] = loadRuns(db)
  assert.equal(r.goal, 'research')
  assert.equal(r.rounds, 4)
  assert.equal(r.stopEarly, false)
  assert.equal(JSON.parse(readFileSync(join(h, 'sessions.json'), 'utf8')).length, 2, 'the old file stays')
  db.close()
})

test('runs: storing the active list ends the ones no longer in it', () => {
  const db = open(home())
  const r = { session: 'a', goal: 'g', until: 1, rounds: 0, started: 1, notes: 'n', maxRounds: 5 }
  storeRuns(db, [r, { ...r, session: 'b' }])
  assert.equal(loadRuns(db).length, 2)
  storeRuns(db, [{ ...r, rounds: 2, nextAt: 99 }])
  const left = loadRuns(db)
  assert.deepEqual(left.map(x => [x.session, x.rounds, x.nextAt]), [['a', 2, 99]])
  assert.equal(db.get("SELECT status FROM runs WHERE session = 'b'").status, 'ended')
  db.close()
})

test('transactions roll back as a whole, also when nested', () => {
  const db = open(home())
  assert.throws(() => db.tx(() => {
    db.run("INSERT INTO meta (key, value) VALUES ('x', '1')")
    db.tx(() => db.run("INSERT INTO meta (key, value) VALUES ('y', '1')"))
    throw new Error('boom')
  }))
  assert.equal(db.get('SELECT COUNT(*) AS n FROM meta').n, 0)
  db.tx(() => { db.meta('a', { n: 1 }); db.tx(() => db.meta('b', 2)) })
  assert.deepEqual(db.meta('a'), { n: 1 })
  assert.equal(db.meta('b'), 2)
  db.close()
})

test('a backup is made once a day, and only the last 7 are kept', () => {
  const h = home()
  const db = open(h)
  db.run("INSERT INTO sessions (name) VALUES ('main')")
  const first = backup(db, new Date(2026, 10, 1, 9))
  assert.ok(existsSync(first))
  assert.equal(backup(db, new Date(2026, 10, 1, 18)), null, 'once a day')
  for (let d = 2; d <= 10; d++) backup(db, new Date(2026, 10, d, 9))
  const files = readdirSync(join(h, 'backups')).sort()
  assert.equal(files.length, 7)
  assert.equal(files.at(-1), 'work-2026-11-10.db')
  const copy = new DatabaseSync(join(h, 'backups', files.at(-1)))
  assert.equal(copy.prepare('SELECT name FROM sessions').get().name, 'main', 'the copy is a working db')
  copy.close()
  db.close()
})

test('the worker secret is made once and kept', () => {
  const h = home()
  const s = workerSecret(h)
  assert.match(s, /^[0-9a-f]{64}$/)
  assert.equal(workerSecret(h), s)
})

test('a lost work.db does not bring back sessions.json and runs.json', () => {
  const h = home()
  writeFileSync(join(h, 'sessions.json'), JSON.stringify([{ name: 'lr', dir: h }]))
  writeFileSync(join(h, 'runs.json'), JSON.stringify([{ session: 'lr', goal: 'old goal', until: Date.now() + 36e6, rounds: 3, started: Date.now(), notes: 'n', maxRounds: 200 }]))
  let db = open(h)
  assert.equal(importLegacy(db).runs, 1)
  storeRuns(db, []) // the run is stopped
  db.close()
  for (const f of ['work.db', 'work.db-wal', 'work.db-shm']) rmSync(join(h, f), { force: true })
  db = open(h)
  assert.deepEqual(importLegacy(db), { sessions: 0, runs: 0, stale: [] })
  assert.deepEqual(loadRuns(db), [], 'the stopped run stays stopped')
  assert.equal(db.get('SELECT COUNT(*) AS n FROM sessions').n, 0)
  db.close()
})

test('the import says when the old files changed after it', async () => {
  const h = home()
  writeFileSync(join(h, 'sessions.json'), '[]')
  const db = open(h)
  importLegacy(db)
  await new Promise(r => setTimeout(r, 30))
  writeFileSync(join(h, 'runs.json'), '[]')
  assert.deepEqual(importLegacy(db).stale, ['runs.json'])
  db.close()
})

test('a damaged work.db is set aside and the newest backup takes its place', () => {
  const h = home()
  let db = open(h)
  db.run("INSERT INTO sessions (name) VALUES ('kept')")
  backup(db, new Date(2026, 10, 1, 9))
  db.close()
  for (const f of ['work.db-wal', 'work.db-shm']) rmSync(join(h, f), { force: true })
  writeFileSync(join(h, 'work.db'), 'this is not a database'.repeat(300))
  db = open(h)
  assert.equal(db.restored.from, 'work-2026-11-01.db')
  assert.equal(db.get('SELECT name FROM sessions').name, 'kept')
  assert.ok(existsSync(join(h, db.restored.kept)), 'the damaged file is kept')
  db.close()
})

test('a damaged work.db with no backup starts empty', () => {
  const h = home()
  writeFileSync(join(h, 'work.db'), 'this is not a database'.repeat(300))
  const db = open(h)
  assert.equal(db.restored.from, null)
  assert.equal(db.get('SELECT COUNT(*) AS n FROM sessions').n, 0)
  db.close()
})

test('an older work.db gets the columns added since', () => {
  const h = home()
  const old = new DatabaseSync(join(h, 'work.db'))
  old.exec('CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT UNIQUE, session TEXT, status TEXT); CREATE TABLE permissions (id INTEGER PRIMARY KEY AUTOINCREMENT, task INTEGER, status TEXT)')
  old.close()
  const db = open(h)
  assert.ok(db.all('PRAGMA table_info(tasks)').some(c => c.name === 'starts'))
  assert.ok(db.all('PRAGMA table_info(permissions)').some(c => c.name === 'start'))
  db.close()
})

test('a backup cut off by a kill leaves no broken copy behind', () => {
  const h = home()
  const db = open(h)
  backup(db, new Date(2026, 10, 1, 9))
  // What a kill mid-copy on an earlier day leaves.
  writeFileSync(join(h, 'backups', 'work-2026-11-02.db.tmp'), 'half a copy')
  backup(db, new Date(2026, 10, 3, 9))
  assert.deepEqual(readdirSync(join(h, 'backups')).sort(), ['work-2026-11-01.db', 'work-2026-11-03.db'])
  db.close()
})

test('an empty worker.secret is replaced by a real key', () => {
  const h = home()
  writeFileSync(join(h, 'worker.secret'), '')
  assert.match(workerSecret(h), /^[0-9a-f]{64}$/)
  assert.match(readFileSync(join(h, 'worker.secret'), 'utf8'), /^[0-9a-f]{64}$/)
})

test('processes making the worker secret at the same moment all get the same full key', async () => {
  const mod = new URL('../src/worker-secret.js', import.meta.url).href
  for (let trial = 0; trial < 15; trial++) {
    const h = home()
    const code = `const { workerSecret } = await import(${JSON.stringify(mod)}); const at = Number(process.argv[1]); while (Date.now() < at); process.stdout.write(workerSecret(process.argv[2]))`
    const at = Date.now() + 400
    const outs = await Promise.all([1, 2, 3, 4].map(() => new Promise(res => {
      const c = spawn(process.execPath, ['--input-type=module', '-e', code, String(at), h])
      let out = ''
      c.stdout.on('data', d => { out += d })
      c.stderr.on('data', d => { out += String(d).slice(0, 300) })
      c.on('exit', () => res(out))
    })))
    assert.ok(outs.every(o => /^[0-9a-f]{64}$/.test(o)), JSON.stringify(outs))
    assert.equal(new Set(outs).size, 1, 'one key')
  }
})
