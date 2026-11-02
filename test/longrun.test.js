import { tick } from './setup.js'
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const longrun = await import('../src/longrun.js')

let clock = Date.parse('2026-11-02T00:00:00Z')
let prompts = []
let notices = []
let reply = () => 'did a step'
beforeEach(() => { prompts = []; notices = []; reply = () => 'did a step' })
longrun.setDeps({
  now: () => clock,
  pause: 0,
  notify: n => notices.push(n),
  // Stand-in for a Claude round: answers right away, one hour passes per round.
  ask: (prompt, { onDone }) => { prompts.push(prompt); setTimeout(() => { clock += 3600e3; const r = reply(prompts.length); r instanceof Error ? onDone('', r.message) : onDone(r, null) }, 0); return { ok: true } },
})
const settle = async () => { for (let i = 0; i < 50 && !notices.length; i++) await tick(5) }

test('rounds keep coming until the time is up, then one call with the result', async () => {
  const r = longrun.startRun({ session: 'main', hours: 3, goal: 'Find a venture-scale idea. Read the brief first.' })
  assert.equal(r.ok, true)
  await settle()
  assert.equal(prompts.length, 3, 'one round per hour for 3 hours')
  assert.match(prompts[0], /Goal:\nFind a venture-scale idea/)
  assert.match(prompts[0], /working notes in .*main-notes\.md/)
  assert.match(prompts[1], /round 2/)
  assert.match(prompts[2], /Time is almost up/, 'the last round asks for the final result')
  assert.equal(notices.length, 1)
  assert.match(notices[0].text, /ended because time is up, after 3 rounds/)
  assert.deepEqual(longrun.list(), [])
})

test('the session can finish early by saying so', async () => {
  reply = n => n === 2 ? 'Here is the final idea. RUN COMPLETE' : 'step'
  longrun.startRun({ session: 'main', hours: 10, goal: 'g' })
  await settle()
  assert.equal(prompts.length, 2)
  assert.match(notices[0].text, /the session finished the goal, after 2 rounds[^]*final idea/)
  assert.doesNotMatch(notices[0].text, /RUN COMPLETE/)
})

test('a failed round ends the run and says why', async () => {
  reply = () => new Error('model overloaded')
  longrun.startRun({ session: 'main', hours: 5, goal: 'g' })
  await settle()
  assert.match(notices[0].text, /a round failed: model overloaded/)
})

test('runs are saved so a restart can pick them up', () => {
  reply = () => 'step'
  longrun.setDeps({ ask: (p, o) => { prompts.push(p); return { ok: true } } }) // a round that never ends
  longrun.startRun({ session: 'main', hours: 24, goal: 'overnight' })
  const saved = JSON.parse(readFileSync(join(process.env.ANTON_HOME, 'runs.json'), 'utf8'))
  assert.equal(saved[0].session, 'main')
  assert.equal(saved[0].goal, 'overnight')
  assert.equal(longrun.startRun({ session: 'main', hours: 1, goal: 'again' }).ok, false, 'one run per session')
  assert.equal(longrun.stopRun('main').ok, true)
  assert.match(notices.at(-1).text, /because you stopped it/)
})

test('bad requests get plain answers', () => {
  assert.match(longrun.startRun({ session: 'nobody', hours: 1, goal: 'g' }).reason, /No session named nobody/)
  assert.match(longrun.startRun({ session: 'main', hours: 0, goal: 'g' }).reason, /between/)
  assert.match(longrun.startRun({ session: 'main', hours: 100, goal: 'g' }).reason, /72 hours/)
  assert.match(longrun.startRun({ session: 'main', hours: 1, goal: ' ' }).reason, /what the run is for/)
})
