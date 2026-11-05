import './setup.js'
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import * as caller from '../src/caller.js'

let dials = 0
caller.setDialer(() => { dials++ })
// A call that connects and ends hands over the held updates and clears them.
const pickUp = () => { const heard = caller.callStarted({ inject() {} }); caller.callEnded({ userSpoke: true, updates: heard }); return heard }
beforeEach(() => { pickUp(); dials = 0 })

test('without a promise, each finished task calls', () => {
  caller.notify({ kind: 'done', session: 'main', text: 'main done' })
  assert.equal(dials, 1)
})

test('call me back: results are held until the last session finishes, then one call', () => {
  const r = caller.callBackWhenDone(['main', 'muse'], 'the research and the fix')
  assert.equal(r.ok, true)
  caller.notify({ kind: 'done', session: 'main', text: 'main: fixed it' })
  assert.equal(dials, 0, 'still waiting on muse')
  caller.notify({ kind: 'note', session: 'hub', text: 'grokbot posted' })
  assert.equal(dials, 0, 'other news waits for the promised call')
  caller.notify({ kind: 'done', session: 'muse', text: 'muse: three papers' })
  assert.equal(dials, 1)
  const heard = pickUp()
  assert.match(heard[0], /You asked me to call when this was done \(the research and the fix\)/)
  assert.ok(heard.includes('main: fixed it') && heard.includes('muse: three papers') && heard.includes('grokbot posted'))
  assert.equal(caller.pendingCallback(), null)
})

test('a permission question still calls while a callback is pending', () => {
  caller.callBackWhenDone(['main'])
  caller.notify({ kind: 'permission', session: 'main', text: 'main wants to run npm install' })
  assert.equal(dials, 1)
  caller.notify({ kind: 'done', session: 'main', text: 'done' })
})

test('a failed task counts as finished', () => {
  caller.callBackWhenDone(['main'])
  caller.notify({ kind: 'failed', session: 'main', text: 'main ended early' })
  assert.equal(dials, 1)
})

test('nothing to wait for is said plainly', () => {
  const r = caller.callBackWhenDone([])
  assert.equal(r.ok, false)
})

test('a newer note from the same session replaces the older one in the queue', () => {
  for (let i = 1; i <= 4; i++) caller.notify({ kind: 'note', ring: false, session: 'vision-24h', text: `waiting on you, version ${i}` })
  caller.notify({ kind: 'done', session: 'main', text: 'main finished' })
  const heard = pickUp()
  assert.deepEqual(heard, ['waiting on you, version 4', 'main finished'])
})

test('with keepIn, updates not heard yet survive a restart of the front', async () => {
  const { join } = await import('node:path')
  const file = join(process.env.ANTON_HOME, 'unheard-test.json')
  // Each import with a new query is a fresh copy of caller.js: a restarted front.
  const fresh = async n => { const c = await import(`../src/caller.js?front=${n}`); let rang = 0; c.setDialer(() => { rang++ }); c.keepIn(file); return { c, rang: () => rang } }
  const first = await fresh(1)
  first.c.notify({ kind: 'note', ring: false, session: 'lr', text: 'the long run is waiting on you' })
  first.c.notify({ kind: 'done', session: 'main', text: 'main finished' })
  assert.equal(first.rang(), 1)
  // The call connects but the user never speaks, then the front is restarted.
  first.c.callStarted({ inject() {} })
  const second = await fresh(2)
  assert.deepEqual(second.c.heldUpdates(), ['the long run is waiting on you', 'main finished'])
  assert.equal(second.rang(), 1, 'it rings again for the update that wanted a call')
  const heard = second.c.callStarted({ inject() {} })
  second.c.callEnded({ userSpoke: true, updates: heard })
  const third = await fresh(3)
  assert.deepEqual(third.c.heldUpdates(), [], 'heard updates are not kept')
  assert.equal(third.rang(), 0)
})

// 2026-11-04: "don't call me, I'm at dinner, call me in 45 minutes" was only a note,
// so the callback rang 3 minutes later. dont_call is now enforced.
test('do-not-call holds every call, even a promised callback and a permission question', () => {
  caller.dontCall(45, 'at dinner')
  assert.ok(caller.dontCallUntil())
  caller.callBackWhenDone(['main'], 'the artifact')
  caller.notify({ kind: 'done', session: 'main', text: 'artifact done' })
  caller.notify({ kind: 'permission', session: 'main', text: 'main wants to run npm install' })
  assert.equal(dials, 0)
  assert.ok(caller.heldUpdates().includes('artifact done'))
  caller.dontCall(0)
  assert.equal(dials, 1, 'clearing it places the one waiting call')
})

test('when the do-not-call time passes, the waiting call goes out by itself', async () => {
  caller.dontCall(0.002, 'short') // about 120 ms
  caller.notify({ kind: 'done', session: 'main', text: 'main finished' })
  assert.equal(dials, 0)
  await new Promise(r => setTimeout(r, 1400))
  assert.equal(dials, 1)
  assert.equal(caller.dontCallUntil(), null)
})

test('do-not-call survives a restart of the front', async () => {
  caller.dontCall(30, 'at dinner')
  const fresh = await import(`../src/caller.js?restart=${Date.now()}`)
  assert.equal(fresh.dontCallUntil()?.reason, 'at dinner')
  caller.dontCall(0)
})
