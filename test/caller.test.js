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
