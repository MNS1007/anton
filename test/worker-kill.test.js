// The worker design's acceptance test. The real front (src/index.js, WORKER=on)
// starts the worker; tasks, porch tasks with permission questions, and a long run
// are queued; then the front is killed 5 times and the worker 3 times (mid-task,
// mid-permission, mid-delivery) at random points. Every task must end done, no
// result may be delivered twice, every long-run round must complete once, and
// nothing may be lost. Stub Agent SDK, fake porch, no phone: nothing leaves the
// laptop. Set KILL_SEED to replay a run.
import './setup.js'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as h from './worker-helpers.js'
import { fakePorch } from './fixtures/fake-porch.js'

const seed = Number(process.env.KILL_SEED) || Date.now() % 1e6
// A small seeded generator, so a failing run can be replayed.
let prng = seed
const rand = () => { prng = (prng * 1103515245 + 12345) % 2147483648; return prng / 2147483648 }
const between = (a, b) => Math.round(a + rand() * (b - a))

const pids = new Set()
let front = null
const porch = fakePorch({ delay: 250 })
let approving = true
let home = null
after(async () => {
  approving = false
  if (front) { h.kill(front); await front.exited }
  // Whatever worker is current, and every one seen.
  try { pids.add(Number(readFileSync(join(home, 'worker.pid'), 'utf8'))) } catch {}
  for (const p of pids) h.kill(p)
  porch.close()
})

test(`kill the front 5 times and the worker 3 times: nothing lost, nothing twice (seed ${seed})`, { timeout: 240000 }, async () => {
  await porch.ready
  home = h.tempHome()
  const env = h.childEnv({
    ANTON_HOME: home, WORK_DIR: home, WORKER: 'on', PORT: String(await h.freePort()), WORKER_PORT: String(await h.freePort()),
    PORCH_URL: porch.url, PORCH_TOKEN: 'anton', MAX_RUNNING: '3',
  })
  const frontLog = []
  const startFront = async () => {
    front = spawn(process.execPath, [h.FRONT], { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    front.exited = new Promise(r => front.once('exit', r))
    for (const s of [front.stdout, front.stderr]) s.on('data', d => frontLog.push(...String(d).split('\n')))
    const f = front
    await h.until(async () => f.exitCode === null && (await fetch(`http://127.0.0.1:${env.PORT}/health`)).ok, { what: 'the front' })
  }
  const workerPid = () => { const p = Number(readFileSync(join(home, 'worker.pid'), 'utf8')); pids.add(p); return p }
  const state = async () => (await h.api(home, '/state')).body
  const m = () => h.metrics(home)

  await startFront()
  await h.workerUp(home)
  workerPid()
  await h.until(() => porch.streams.size > 0, { what: 'the porch watcher' })

  // Work: sessions, tasks (some ask permission), porch tasks, and a long run.
  for (const name of ['a', 'b', 'c', 'lr']) assert.equal((await h.call(home, 'createSession', { name, purpose: name })).ok, true)
  const sessions = ['main', 'a', 'b', 'c']
  // At most ten tasks may wait, so: 8 jobs (3 run, 5 wait), 3 porch tasks and a round.
  for (let i = 0; i < 8; i++) {
    const ask = i % 2 === 1 ? ` [ask:echo ${i}]` : ''
    const r = await h.call(home, 'ask', `job ${i} [id=j${i}] [ms=${between(3000, 6000)}]${ask}`, { session: sessions[i % 4], queue: true })
    assert.equal(r.ok, true, JSON.stringify(r))
  }
  const porchTasks = [0, 1, 2].map(i => porch.add('me', { room: 'dm:anton+me', to: ['anton'], text: `${sessions[i + 1]}: porch job [id=p${i}] [ms=${between(1000, 2500)}]` }))
  assert.equal((await h.call(home, 'startRun', { session: 'lr', hours: 1, goal: 'keep researching [ms=2000]', maxRounds: 8 })).ok, true)

  // The owner answers permission questions a little after they are asked.
  const firstSeen = new Map()
  const approver = (async () => {
    while (approving) {
      try {
        for (const p of (await state()).pending) {
          if (!firstSeen.has(p.session)) firstSeen.set(p.session, Date.now())
          if (Date.now() - firstSeen.get(p.session) > 1500) { await h.call(home, 'answerPermission', true, null, p.session); firstSeen.delete(p.session) }
        }
      } catch {}
      await h.sleep(300)
    }
  })()

  // Kills, in a random order. Worker kills wait for their moment (up to 6 s).
  const moments = {
    task: async () => (await state()).sessions.some(s => s.running && !s.waitingForPermission),
    permission: async () => (await state()).pending.length > 0,
    delivery: async () => porch.inflight > 0,
  }
  const plan = ['front', 'front', 'front', 'front', 'front', 'worker:task', 'worker:permission', 'worker:delivery'].sort(() => rand() - 0.5)
  const hits = []
  for (const kill of plan) {
    await h.sleep(between(300, 1000))
    if (kill === 'front') {
      h.kill(front)
      await front.exited
      await h.sleep(between(200, 1200))
      await startFront()
      hits.push('front')
      continue
    }
    const why = kill.split(':')[1]
    const hit = await h.until(moments[why], { timeout: 15000, every: 20 }).then(() => true, () => false)
    const pid = workerPid()
    h.kill(pid)
    hits.push(`worker ${why}${hit ? '' : ' (no such moment)'}`)
    // The front's supervisor starts a new one.
    await h.until(async () => existsSync(join(home, 'worker.pid')) && workerPid() !== pid && (await h.api(home, '/health')).body?.ready, { what: 'the restarted worker' })
  }

  // Everything settles.
  const done = await h.until(async () => {
    const x = await m()
    const replies = porchTasks.every(t => porch.messages.some(p => p.from === 'anton' && p.reply_to === t.id && /^\[\w+\] done p\d$/.test(p.text)))
    return x.tasks.queued === 0 && x.tasks.running === 0 && x.undelivered === 0 && x.runs.active === 0 && x.outbox.waiting === 0 && replies && x
  }, { timeout: 120000, every: 250, what: 'all work to finish' }).catch(async err => {
    console.log(`seed ${seed}, home ${home}, kills: ${hits.join(', ')}`)
    console.log(JSON.stringify(await m().catch(() => null)))
    console.log(readFileSync(join(home, 'worker.log'), 'utf8').split('\n').slice(-60).join('\n'))
    throw err
  })
  approving = false
  await approver
  await h.sleep(1500) // relays still on their way to porch
  const final = await m()
  console.log(`seed ${seed}, home ${home}, kills: ${hits.join(', ')}`)
  console.log(JSON.stringify(final))
  assert.equal(final.lost, 0, 'lost')
  assert.equal(final.duplicates, 0, 'duplicates')
  assert.ok(final.tasks.interrupted >= 1, 'the worker kills interrupted something')
  assert.deepEqual(hits.filter(x => x.includes('no such moment')), [], 'each worker kill landed mid-task, mid-permission and mid-delivery')

  // The front first, so its supervisor does not start the worker again.
  h.kill(front)
  await front.exited
  const pid = workerPid()
  await h.api(home, '/shutdown', {})
  await h.until(() => { try { process.kill(pid, 0); return false } catch { return true } }, { what: 'the worker to stop' })

  const db = await h.readDb(home)
  // Every task ends done, and its result was delivered once.
  assert.deepEqual(db.tasks.filter(t => t.status !== 'done').map(t => [t.id, t.status, t.error]), [])
  assert.ok(db.tasks.every(t => t.delivered === 1))
  const delivered = new Map()
  for (const e of db.events.filter(e => e.kind === 'delivered')) delivered.set(e.task, (delivered.get(e.task) || 0) + 1)
  assert.ok([...delivered.values()].every(n => n === 1), 'no result delivered twice')
  assert.ok(db.sent.every(s => s.posts <= 1), 'no porch post made twice')
  for (let i = 0; i < 8; i++) assert.ok(db.tasks.some(t => t.result === `done j${i}`), `job ${i}`)

  // Every long-run round completes once, and the run ends after all eight.
  const rounds = db.tasks.filter(t => /"type":"longrun"/.test(t.deliver_json)).map(t => JSON.parse(t.deliver_json).round).sort((a, b) => a - b)
  assert.deepEqual(rounds, [1, 2, 3, 4, 5, 6, 7, 8])

  // Porch: each task answered once, and no post from Anton repeated.
  for (const t of porchTasks) assert.equal(porch.messages.filter(p => p.from === 'anton' && p.reply_to === t.id && /done p\d$/.test(p.text)).length, 1)
  // A question asked again after a kill (its answer had already been used, so the
  // command may have run) is a new question with the same words: one post per question.
  const asks = porch.messages.filter(p => p.from === 'anton' && /is asking permission/.test(p.text))
  assert.equal(asks.length, db.permissions.length, 'each permission question posted once')
  const posts = porch.messages.filter(p => p.from === 'anton' && !asks.includes(p)).map(p => `${p.room}|${p.reply_to}|${p.text}`)
  assert.deepEqual(posts.filter((x, i) => posts.indexOf(x) !== i), [], 'a porch post repeated')

  // The front passed on each notice once, across all its restarts.
  const passed = frontLog.map(l => /worker notice (\S+):/.exec(l)?.[1]).filter(Boolean)
  assert.equal(new Set(passed).size, passed.length, 'a notice passed on twice')
  assert.equal(passed.length, db.outbox.length, 'every notice reached the front')
  assert.ok(db.outbox.some(o => o.kind === 'permission') && db.outbox.some(o => /long run in lr ended because it reached 8 rounds/.test(o.text)))
})
