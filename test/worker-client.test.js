// The phone tools with WORKER=on: tools.js talks to a real worker process through
// worker-client.js, as a call would. Stub Agent SDK; the worker's notices go to a
// stand-in for the front's /notify.
import './setup.js'
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as h from './worker-helpers.js'

const home = process.env.ANTON_HOME
const env = { WORKER_PORT: String(await h.freePort()), PORT: String(await h.freePort()) }
process.env.WORKER_PORT = env.WORKER_PORT
const front = h.fakeFront(Number(env.PORT))
await front.ready

const local = await import('../src/agent.js')
const { use } = await import('../src/runner.js')
const client = await import('../src/worker-client.js')
const { callTools } = await import('../src/tools.js')

let worker = null
before(async () => {
  worker = h.startWorker(home, env)
  await h.workerUp(home, worker.pid)
  use(client, { isRemote: true })
  await client.start({ every: 200 })
})
after(async () => {
  use(local)
  h.kill(worker)
  await worker.exited
  front.server.close()
})

const tools = callTools()
const run = async (name, args = {}) => { tools.userSpoke(); return tools.run(name, args) }
const idle = () => h.until(async () => { await client.refresh(); return !client.status('main').running }, { what: 'main to be idle' })

test('ask_claude and get_status go through the worker', async () => {
  const r = await run('ask_claude', { message: 'look at the logs [id=c1] [ms=600]' })
  assert.equal(r.ok, true)
  assert.equal(r.session, 'main')
  const s = await run('get_status')
  assert.match(s.sessions.find(x => x.name === 'main').state, /working on "look at the logs/)
  await idle()
  assert.equal(client.status('main').lastResult, 'done c1')
  await h.until(() => front.notices.some(n => /Its reply: done c1/.test(n.notice.text)), { what: 'the done notice' })
})

test('a permission question shows up on the call and the answer reaches the task', async () => {
  await run('ask_claude', { message: 'clean up [id=c2] [ask:rm -rf build] [ms=200]' })
  await h.until(async () => { await client.refresh(); return client.hasPendingPermission() }, { what: 'the question' })
  assert.match(client.pendingPermissions()[0].summary, /rm -rf build/)
  assert.match((await run('get_status', { session: 'main' })).waitingForPermission, /rm -rf build/)
  assert.equal((await run('answer_permission', { approve: true })).ok, true)
  await idle()
  assert.equal(client.status('main').lastResult, 'done c2')
})

test('call_me_back holds the results and rings once, when the last one is done', async () => {
  await run('create_session', { name: 'docs', purpose: 'docs' })
  await run('ask_claude', { message: 'one [id=c3] [ms=500]', session: 'main' })
  await run('ask_claude', { message: 'two [id=c4] [ms=1200]', session: 'docs' })
  const r = await run('call_me_back', { note: 'the two tasks' })
  assert.equal(r.ok, true)
  assert.deepEqual(r.waiting.sort(), ['docs', 'main'])
  const done = await h.until(() => {
    const ns = front.notices.filter(n => /done c3|done c4/.test(n.notice.text))
    return ns.length === 2 && ns
  }, { what: 'both results' })
  assert.deepEqual(done.map(n => n.notice.ring), [false, true], 'held, then one call')
  assert.match(done[1].notice.text, /^You asked me to call when this was done \(the two tasks\)/)
})

test('long runs and stopping a task, from the call', async () => {
  const lr = await run('start_long_run', { session: 'docs', hours: 1, goal: 'keep the docs current [ms=3000]' })
  assert.equal(lr.ok, true)
  await client.refresh()
  assert.match((await run('get_status')).sessions.find(s => s.name === 'docs').longRun, /hours left/)
  assert.equal((await run('stop_long_run', { session: 'docs' })).ok, true)
  await run('ask_claude', { message: 'a long one [id=c5] [ms=60000]', session: 'main' })
  await h.until(async () => { await client.refresh(); return client.status('main').running }, { what: 'the task to start' })
  assert.equal((await run('stop_task', { session: 'main' })).ok, true)
  await idle()
  assert.match(client.status('main').lastResult, /stopped by the user/)
})

test('with the worker down, the tools say so instead of failing', async () => {
  h.kill(worker)
  await worker.exited
  const r = await run('ask_claude', { message: 'anything' })
  assert.equal(r.ok, false)
  assert.match(r.reason, /worker that runs Claude is not answering/)
  worker = h.startWorker(home, env)
  await h.workerUp(home, worker.pid)
})
