// The worker in its own process, with the stub Agent SDK: resume after a crash,
// delivery that happens once, permissions that survive a restart, the outbox,
// one worker at a time, and an API only this laptop's Anton can use.
import './setup.js'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as h from './worker-helpers.js'
import { fakePorch } from './fixtures/fake-porch.js'

const children = new Set()
const closers = []
after(async () => {
  for (const c of children) h.kill(c)
  for (const c of children) await c.exited
  for (const fn of closers) fn()
})

async function setup(extra = {}) {
  const home = h.tempHome()
  const env = { WORKER_PORT: String(await h.freePort()), PORT: String(await h.freePort()), ...extra }
  const front = h.fakeFront(Number(env.PORT))
  await front.ready
  closers.push(() => front.server.close())
  const start = async (more = {}) => {
    const w = h.startWorker(home, { ...env, ...more })
    children.add(w)
    w.exited.then(() => children.delete(w))
    await h.workerUp(home, w.pid)
    return w
  }
  const crash = async w => { h.kill(w); await w.exited }
  return { home, env, front, start, crash }
}

const calls = home => { try { return readFileSync(join(home, 'stub', 'calls.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)) } catch { return [] } }
const { peekDb, writeDb } = h

test('a task killed mid-turn resumes its own Claude conversation and finishes once', async () => {
  const { home, front, start, crash } = await setup()
  let w = await start()
  const r = await h.call(home, 'ask', 'summarize the repo [id=r1] [ms=2500]', {})
  assert.equal(r.ok, true)
  await h.until(() => calls(home).length === 1, { what: 'the first turn' })
  await h.sleep(400) // a heartbeat or two
  await crash(w)
  w = await start()
  const m = await h.until(async () => { const x = await h.metrics(home); return x.tasks.done === 1 && x }, { what: 'the resumed task' })
  const [first, second] = calls(home)
  assert.equal(second.resumed, true, 'continued, not started over')
  assert.equal(second.resume, first.sid, 'in the same Claude conversation')
  assert.match(second.prompt, /^Your previous turn was interrupted by a restart\. Continue from where you stopped and finish: summarize the repo/)
  assert.equal(m.lost, 0)
  assert.equal(m.tasks.resumed, 1)
  assert.ok(m.resumeLatencyMs.max > 0)
  await h.until(() => front.notices.length === 1, { what: 'the notice' })
  assert.match(front.notices[0].notice.text, /finished "summarize the repo[^"]*"\. Its reply: done r1/)
  await crash(w)
  const db = await h.readDb(home)
  assert.equal(db.tasks[0].attempts, 1)
  assert.equal(db.events.filter(e => e.kind === 'delivered').length, 1)
})

test('after three resumes a task fails, and the owner hears it', async () => {
  const { home, front, start, crash } = await setup()
  let w = await start()
  await h.call(home, 'ask', 'never ends [id=r2] [ms=60000]', {})
  for (let i = 1; i <= 4; i++) {
    await h.until(() => calls(home).length === i, { what: `turn ${i}` })
    await crash(w)
    w = await start()
  }
  await h.until(async () => (await h.metrics(home)).tasks.failed === 1, { what: 'the task to fail' })
  await h.until(() => front.notices.some(n => n.notice.kind === 'failed'), { what: 'the failure notice' })
  assert.match(front.notices.find(n => n.notice.kind === 'failed').notice.text, /ended early: it was interrupted by restarts 4 times/)
  assert.equal(calls(home).length, 4, 'one first run and three resumes')
  assert.equal((await h.metrics(home)).lost, 0)
  await crash(w)
})

test('a porch reply cut off mid-post is not posted again after the restart', async () => {
  const porch = fakePorch({ delay: 1500 })
  await porch.ready
  closers.push(porch.close)
  const { home, start, crash } = await setup({ PORCH_URL: porch.url, PORCH_TOKEN: 'anton' })
  let w = await start()
  await h.until(() => porch.streams.size > 0, { what: 'the porch watcher' })
  let killed = false
  porch.onPost = m => { if (!killed && m.text.startsWith('[main] done p1')) { killed = true; h.kill(w) } }
  const task = porch.add('me', { room: 'dm:anton+me', to: ['anton'], text: 'main: tidy the readme [id=p1] [ms=200]' })
  await h.until(() => killed, { what: 'the reply to start posting' })
  await w.exited
  w = await start()
  await h.until(async () => (await h.metrics(home)).undelivered === 0 && (await h.metrics(home)).tasks.done === 1, { what: 'the delivery' })
  await h.sleep(500)
  const replies = porch.messages.filter(m => m.from === 'anton' && m.reply_to === task.id)
  assert.equal(replies.filter(m => m.text === '[main] done p1').length, 1, 'the answer once')
  assert.equal(replies.filter(m => /^On it/.test(m.text)).length, 1, 'the "on it" note once')
  const m = await h.metrics(home)
  assert.equal(m.duplicates, 0)
  await crash(w)
})

// The owner's porch messages, handled again after a kill (the cursor moves on only
// once a message is handled), must not do anything twice or anything new.
async function porchSetup(extra = {}) {
  const porch = fakePorch()
  await porch.ready
  closers.push(porch.close)
  const s = await setup({ PORCH_URL: porch.url, PORCH_TOKEN: 'anton', ...extra })
  s.porch = porch
  s.w = await s.start()
  await h.until(() => porch.streams.size > 0, { what: 'the porch watcher' })
  const owner = text => porch.add('me', { room: 'dm:anton+me', to: ['anton'], text })
  // One message handled first, so the watcher has saved its place on porch.
  const help = owner('help')
  await h.until(() => porch.messages.some(m => m.reply_to === help.id), { what: 'the help reply' })
  await h.sleep(200)
  // Kill the worker while its first reply to msg is on its way to porch, then start again.
  s.killMidReply = async msg => {
    porch.delay = 8000
    await h.until(() => porch.messages.some(m => m.reply_to === msg.id), { what: 'the reply to go out' })
    await s.crash(s.w)
    porch.delay = 0
    s.w = await s.start()
    await h.until(() => porch.streams.size > 0, { what: 'the porch watcher again' })
    await h.sleep(1500)
  }
  s.repliesTo = msg => porch.messages.filter(m => m.from === 'anton' && m.reply_to === msg.id).map(m => m.text)
  s.owner = owner
  return s
}

test('a porch "yes" handled again after a kill answers only the question it was about', async () => {
  const s = await porchSetup()
  const { home, porch, owner, killMidReply, repliesTo } = s
  assert.equal((await h.call(home, 'createSession', { name: 'b', purpose: 'b' })).ok, true)
  await h.call(home, 'ask', 'task a [id=A] [ms=200] [ask:echo harmless]', {})
  await h.until(async () => (await h.call(home, 'pendingPermissions')).length === 1, { what: 'the first question' })
  porch.delay = 8000
  const yes = owner('yes')
  await h.until(() => porch.inflight > 0, { what: 'the "Approved" reply in flight' })
  await h.until(async () => (await peekDb(home)).tasks[0].status === 'done', { what: 'task a' })
  // Another session asks something else while that reply is still on its way.
  await h.call(home, 'ask', 'task b [id=B] [ms=600] [ask:rm -rf important]', { session: 'b' })
  await h.until(async () => (await h.call(home, 'pendingPermissions')).some(p => p.session === 'b'), { what: 'the second question' })
  await killMidReply(yes)
  const db = await peekDb(home)
  assert.deepEqual(db.permissions.map(p => [p.input_summary.replace(/^.*: /, ''), p.status]), [['echo harmless', 'allowed'], ['rm -rf important', 'pending']], 'the rm was never approved')
  assert.deepEqual(repliesTo(yes), ['Approved. main is carrying on.'], 'one answer to the one "yes"')
  await s.crash(s.w)
})

test('porch commands handled again after a kill give the same reply once', async () => {
  const s = await porchSetup({ LONG_RUN_GAP_MINUTES: '5' })
  const { home, owner, killMidReply, repliesTo } = s
  assert.equal((await h.call(home, 'createSession', { name: 'lr', purpose: 'lr' })).ok, true)
  await h.call(home, 'ask', 'busy [id=X] [ms=30000]', {})
  const queued = owner('main: second job [id=Q] [ms=300]')
  await killMidReply(queued)
  const run = owner('run lr for 1 hours: research [ms=300]')
  await killMidReply(run)
  const q = repliesTo(queued)
  assert.equal(q.length, 1, JSON.stringify(q))
  assert.match(q[0], /^Got it\. main is busy/)
  const r = repliesTo(run)
  assert.equal(r.length, 1, JSON.stringify(r))
  assert.match(r[0], /^Running lr for 1 hours/)
  assert.equal((await h.metrics(home)).duplicates, 0)
  await s.crash(s.w)
})

test('a message sent before the watcher ever saved its place is not skipped after a restart', async () => {
  const porch = fakePorch()
  await porch.ready
  closers.push(porch.close)
  const s = await setup({ PORCH_URL: porch.url, PORCH_TOKEN: 'anton' })
  s.w = await s.start()
  await h.until(() => porch.streams.size > 0, { what: 'the porch watcher' })
  await s.crash(s.w)
  const owner = text => porch.add('me', { room: 'dm:anton+me', to: ['anton'], text })
  const msg = owner('main: hello [id=cz] [ms=50]')
  s.w = await s.start()
  await h.until(() => porch.messages.some(m => m.from === 'anton' && m.reply_to === msg.id && m.text === '[main] done cz'), { what: 'the answer' })
  await s.crash(s.w)
})

test('porch chains run in the worker: a liaison answer, and an ASK chain that survives a crash', async () => {
  const porch = fakePorch({ agents: ['muse'] })
  await porch.ready
  closers.push(porch.close)
  const { home, start, crash } = await setup({ PORCH_URL: porch.url, PORCH_TOKEN: 'anton' })
  let w = await start()
  await h.until(() => porch.streams.size > 0, { what: 'the porch watcher' })

  // Another agent's question gets a read-only answer from the liaison session.
  const q = porch.add('muse', { room: 'dm:anton+muse', text: 'What is Sam working on this week?' })
  const answer = await h.until(() => porch.messages.find(m => m.from === 'anton' && m.reply_to === q.id), { what: 'the liaison answer' })
  assert.match(answer.text, /^done \[A question from muse/)

  // The owner's task needs muse first. Crash once the question to muse is out.
  let asked = null
  porch.onPost = m => { if (!asked && m.from === 'anton' && m.to.includes('muse')) { asked = m; h.kill(w) } }
  const task = porch.add('me', { room: 'dm:anton+me', to: ['anton'], text: 'main: plan the week [id=c1] [reply=ASK muse: when is the deadline?] [ms=200]' })
  await h.until(() => asked, { what: 'the question to muse' })
  await w.exited
  w = await start()
  porch.add('muse', { room: asked.room, reply_to: asked.id, text: 'The deadline is Friday.' })
  const final = await h.until(() => porch.messages.find(m => m.from === 'anton' && m.reply_to === task.id && m.text === '[main] final c1'), { what: 'the final answer' })
  assert.ok(final)
  await h.sleep(800)
  const toOwner = porch.messages.filter(m => m.from === 'anton' && m.reply_to === task.id).map(m => m.text)
  assert.deepEqual(toOwner.filter(t => /Checking with muse/.test(t)).length, 1, 'the "checking" note once')
  assert.equal(porch.messages.filter(m => m.from === 'anton' && m.to.includes('muse') && /when is the deadline/.test(m.text)).length, 1, 'muse asked once')
  const m = await h.metrics(home)
  assert.equal(m.lost, 0)
  assert.equal(m.duplicates, 0)
  await crash(w)
})

test('a permission question survives a restart: same question, one notice, then the answer is used', async () => {
  const { home, front, start, crash } = await setup()
  let w = await start()
  await h.call(home, 'ask', 'deploy it [id=k1] [ask:npm run deploy] [ms=400]', {})
  const pending = await h.until(async () => (await h.call(home, 'pendingPermissions')).at(0), { what: 'the question' })
  assert.equal(pending.session, 'main')
  assert.match(pending.summary, /npm run deploy/)
  await h.until(() => front.notices.some(n => n.notice.kind === 'permission'), { what: 'the permission notice' })
  await crash(w)
  w = await start()
  // The row survived; the resumed task asks again and waits on the same row.
  await h.until(() => calls(home).length === 2, { what: 'the resumed turn' })
  assert.equal((await h.call(home, 'pendingPermissions')).length, 1)
  const r = await h.call(home, 'answerPermission', true, null, 'main')
  assert.equal(r.ok, true)
  await h.until(async () => (await h.metrics(home)).tasks.done === 1, { what: 'the task' })
  await crash(w)
  const db = await h.readDb(home)
  assert.equal(db.permissions.length, 1, 'asked once')
  assert.equal(db.permissions[0].status, 'allowed')
  // The front passes on an outbox id once (index.js), so count ids.
  assert.equal(new Set(front.notices.filter(n => n.notice.kind === 'permission').map(n => n.outbox)).size, 1, 'one call about it')
  assert.match(db.tasks[0].result, /^done k1$/)
})

test('an answer that came while the task never saw it (the worker died first) is used after the restart', async () => {
  const { home, start, crash } = await setup()
  let w = await start()
  await h.call(home, 'ask', 'push it [id=k2] [ask:git push] [ms=3000]', {})
  await h.until(async () => (await h.call(home, 'pendingPermissions')).length, { what: 'the question' })
  await crash(w)
  // The answer lands in work.db after the last poll, before the task could take it.
  await writeDb(home, db => db.prepare("UPDATE permissions SET status = 'allowed', decided = ?").run(Date.now()))
  w = await start()
  await h.until(async () => (await h.metrics(home)).tasks.done === 1, { what: 'the task' })
  await crash(w)
  const db = await h.readDb(home)
  assert.equal(db.permissions.length, 1, 'not asked again')
  assert.equal(db.tasks[0].result, 'done k2')
})

for (const how of ['a kill', 'a clean stop']) {
  test(`an answer that already reached a turn is not given again after ${how}: the owner is asked once more`, async () => {
    const { home, front, start, crash } = await setup()
    let w = await start()
    await h.call(home, 'ask', 'deploy [id=p1] [ask:npm run deploy] [ms=6000]', {})
    await h.until(async () => (await h.call(home, 'pendingPermissions')).length, { what: 'the question' })
    await h.call(home, 'answerPermission', true, null)
    await h.until(async () => (await peekDb(home)).permissions[0].used != null, { what: 'the turn to take the answer' })
    if (how === 'a kill') await crash(w)
    else { await h.api(home, '/shutdown', {}); await w.exited }
    w = await start()
    const again = await h.until(async () => (await h.call(home, 'pendingPermissions')).at(0), { what: 'the question again' })
    assert.match(again.summary, /npm run deploy/)
    await h.until(() => new Set(front.notices.filter(n => n.notice.kind === 'permission').map(n => n.outbox)).size === 2, { what: 'the second question to reach the owner' })
    await h.call(home, 'answerPermission', true, null)
    await h.until(async () => (await h.metrics(home)).tasks.done === 1, { what: 'the task' })
    await crash(w)
    const db = await h.readDb(home)
    assert.deepEqual(db.permissions.map(p => p.status), ['allowed', 'allowed'], 'one answer per turn that ran the command')
    assert.equal(db.tasks[0].result, 'done p1')
  })
}

test('two permission questions at once: each gets its own answer and the task finishes', async () => {
  const { home, start, crash } = await setup()
  const w = await start()
  await h.call(home, 'ask', 'both [id=pp] [ask2:echo one|echo two] [ms=200]', {})
  await h.until(async () => (await peekDb(home)).permissions.length === 2, { what: 'both questions' })
  assert.match((await h.call(home, 'pendingPermissions'))[0].summary, /echo one/, 'the oldest question comes first')
  assert.equal((await h.call(home, 'answerPermission', true, null)).ok, true)
  await h.until(async () => /echo two/.test((await h.call(home, 'pendingPermissions'))[0]?.summary), { what: 'the second question' })
  assert.equal((await h.call(home, 'answerPermission', true, null)).ok, true)
  await h.until(async () => (await h.metrics(home)).tasks.done === 1, { timeout: 8000, what: 'the task' })
  await crash(w)
  const db = await h.readDb(home)
  assert.deepEqual(db.permissions.map(p => p.status), ['allowed', 'allowed'])
  assert.equal(db.tasks[0].result, 'done pp')
})

test('stop reaches a task that waits to resume after a restart, and it never runs again', async () => {
  const { home, start, crash } = await setup({ MAX_RUNNING: '2' })
  let w = await start()
  assert.equal((await h.call(home, 'createSession', { name: 'b', purpose: 'b' })).ok, true)
  await h.call(home, 'ask', 'first [id=q1] [ms=4000]', {})
  await h.call(home, 'ask', 'second [id=q2] [ms=4000]', { session: 'b' })
  await h.until(() => calls(home).length === 2, { what: 'both turns' })
  await crash(w)
  // One slot now: one task resumes, the other waits for it.
  w = await start({ MAX_RUNNING: '1' })
  await h.until(() => calls(home).length === 3, { what: 'one resumed turn' })
  const waiting = calls(home)[2].tag === 'q1' ? 'b' : 'main'
  const r = await h.call(home, 'stop', waiting)
  assert.equal(r.ok, true, JSON.stringify(r))
  await h.until(async () => { const m = await h.metrics(home); return m.tasks.done === 1 && m.tasks.stopped === 1 && m.undelivered === 0 }, { what: 'one done, one stopped' })
  await h.sleep(500)
  assert.equal(calls(home).length, 3, 'the stopped task did not start again')
  await crash(w)
})

test('notices wait in the outbox while the front is down, then arrive once', async () => {
  const { home, front, start, crash } = await setup()
  front.down = true
  const w = await start()
  await h.call(home, 'ask', 'quick one [id=o1] [ms=50]', {})
  await h.until(async () => (await h.metrics(home)).outbox.waiting === 1, { what: 'the waiting notice' })
  await h.sleep(1200)
  assert.equal(front.notices.length, 0)
  front.down = false
  await h.until(() => front.notices.length === 1, { timeout: 30000, what: 'the notice after the front is back' })
  await h.until(async () => (await h.metrics(home)).outbox.waiting === 0, { what: 'the outbox to empty' })
  await h.sleep(2500)
  assert.equal(front.notices.length, 1, 'sent once')
  assert.match(front.notices[0].outbox, /^[0-9a-f-]+:\d+$/, 'an id the front can tell repeats by')
  await crash(w)
})

test('an empty worker.secret is never an open door: it is replaced, and calls without the key are refused', async () => {
  const { home, start, crash } = await setup()
  writeFileSync(join(home, 'worker.secret'), '')
  const w = await start()
  assert.match(h.secret(home), /^[0-9a-f]{64}$/)
  assert.equal((await h.api(home, '/state', undefined, { 'x-worker-secret': '' })).status, 403)
  const port = Number(readFileSync(join(home, 'worker.port'), 'utf8'))
  const plain = await fetch(`http://127.0.0.1:${port}/call`, { method: 'POST', body: JSON.stringify({ fn: 'ask', args: ['hi', {}] }) })
  assert.equal(plain.status, 403, 'a plain POST with no key')
  const page = await fetch(`http://127.0.0.1:${port}/call`, { method: 'POST', headers: { 'Content-Type': 'text/plain', 'x-worker-secret': h.secret(home) }, body: JSON.stringify({ fn: 'list', args: [] }) })
  assert.equal(page.status, 403, 'only JSON is taken, which a web page cannot send without asking')
  assert.equal((await peekDb(home)).tasks.length, 0)
  await crash(w)
})

test('a lock row left with a time in the future (the clock went back) and a reused pid does not keep the worker out', async () => {
  const { home, start, crash } = await setup()
  let w = await start()
  await crash(w)
  // This test's own pid is alive, but no worker answers on the port in the row.
  const nobody = await h.freePort()
  await writeDb(home, db => db.prepare("UPDATE meta SET value = ? WHERE key = 'lock'").run(JSON.stringify({ pid: process.pid, port: nobody, at: Date.now() + 3600e3 })))
  w = await start()
  assert.equal((await h.api(home, '/health')).body.pid, w.pid)
  await crash(w)
})

test('a damaged work.db is replaced by the newest backup, and the owner is told', async () => {
  const { home, front, start, crash } = await setup()
  let w = await start()
  assert.equal((await h.call(home, 'createSession', { name: 'kept', purpose: 'k' })).ok, true)
  await h.api(home, '/shutdown', {})
  await w.exited
  // The only backup has the session in it (the one made at start is older), then the db is ruined.
  rmSync(join(home, 'backups'), { recursive: true, force: true })
  await writeDb(home, db => { mkdirSync(join(home, 'backups'), { recursive: true }); db.exec(`VACUUM INTO '${join(home, 'backups', 'work-2026-11-01.db').replace(/'/g, "''")}'`) })
  for (const f of ['work.db-wal', 'work.db-shm']) if (existsSync(join(home, f))) writeFileSync(join(home, f), '')
  writeFileSync(join(home, 'work.db'), 'this is not a database'.repeat(300))
  w = await start()
  assert.ok((await h.call(home, 'list')).some(s => s.name === 'kept'))
  await h.until(() => front.notices.some(n => /database was damaged, so it started again from the copy made on 2026-11-01/.test(n.notice.text)), { what: 'the notice' })
  assert.ok(readdirSync(home).some(f => /^work\.db\.corrupt-\d+$/.test(f)), 'the damaged file is kept')
  await crash(w)
})

test('one worker at a time, and the API only answers this laptop with the secret', async () => {
  const { home, env, start, crash } = await setup()
  const w = await start()
  const second = h.startWorker(home, env)
  assert.equal(await second.exited, 0, 'the second worker leaves')
  const third = h.startWorker(home, { ...env, WORKER_PORT: String(await h.freePort()) })
  assert.equal(await third.exited, 0, 'a worker on another port leaves too: work.db is taken')
  assert.equal((await h.api(home, '/health')).status, 200)
  assert.equal((await h.api(home, '/health', undefined, { 'x-worker-secret': 'wrong' })).status, 403)
  assert.equal((await h.api(home, '/metrics', undefined, { 'x-forwarded-for': '1.2.3.4' })).status, 403)
  assert.equal((await h.api(home, '/call', { fn: 'constructor', args: [] })).status, 404, 'only the listed calls')
  await crash(w)
})

test('a clean shutdown checkpoints running tasks; they resume without using up an attempt', async () => {
  const { home, start } = await setup()
  let w = await start()
  await h.call(home, 'ask', 'long job sk-PLANTED-123 [id=s1] [ms=2000]', {})
  await h.until(() => calls(home).length === 1, { what: 'the turn' })
  assert.equal((await h.api(home, '/shutdown', {})).status, 200)
  assert.equal(await w.exited, 0)
  let db = await h.readDb(home)
  assert.equal(db.tasks[0].status, 'interrupted')
  assert.equal(db.tasks[0].clean, 1)
  w = await start()
  await h.until(async () => (await h.metrics(home)).tasks.done === 1, { what: 'the task' })
  h.kill(w)
  await w.exited
  db = await h.readDb(home)
  assert.equal(db.tasks[0].attempts, 0, 'a clean stop is not an attempt')
  const logText = readFileSync(join(home, 'worker.log'), 'utf8')
  assert.ok(!logText.includes(h.secret(home)), 'the secret is never logged')
  assert.ok(!logText.includes('sk-PLANTED-123'), 'prompts are never logged')
})
