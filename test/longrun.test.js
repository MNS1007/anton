import { tick } from './setup.js'
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
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
const settle = async () => { for (let i = 0; i < 100 && !notices.some(n => n.kind === 'done'); i++) await tick(5) }

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

test('by default a run lasts the full time even if the session says it is done', async () => {
  reply = n => n === 2 ? 'Here is the final idea. RUN COMPLETE' : 'step'
  longrun.startRun({ session: 'main', hours: 5, goal: 'g' })
  await settle()
  assert.equal(prompts.length, 5, 'kept going after the early RUN COMPLETE')
  assert.match(prompts[0], /there is no finishing early/)
  assert.match(notices.at(-1).text, /time is up, after 5 rounds/)
})

test('with stopEarly the session can finish by saying so', async () => {
  reply = n => n === 2 ? 'Here is the final idea. RUN COMPLETE' : 'step'
  longrun.startRun({ session: 'main', hours: 10, goal: 'g', stopEarly: true })
  await settle()
  assert.equal(prompts.length, 2)
  assert.match(notices[0].text, /the session finished the goal, after 2 rounds[^]*final idea/)
  assert.doesNotMatch(notices[0].text, /RUN COMPLETE/)
})

test('asks under "Waiting on" in the notes reach the user once, without a call', async () => {
  const notes = join(process.env.ANTON_HOME, 'runs', 'main-notes.md')
  reply = n => { if (n === 1) writeFileSync(notes, '# notes\n## Waiting on Sam\n- Approve $40 of API spend for the paid test arms.\n## Next\n- more\n'); return 'step' }
  longrun.startRun({ session: 'main', hours: 3, goal: 'g' })
  await settle()
  const asks = notices.filter(n => /waiting on you/.test(n.text))
  assert.equal(asks.length, 1, 'shared once, not every round')
  assert.equal(asks[0].ring, false)
  assert.match(asks[0].text, /Approve \$40 of API spend/)
  assert.doesNotMatch(asks[0].text, /## Next/)
  assert.match(prompts[0], /## Waiting on Sam/)
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

test('the round cap scales with the run, so fast rounds do not end it early', () => {
  longrun.setDeps({ ask: () => ({ ok: true }) })
  longrun.startRun({ session: 'main', hours: 24, goal: 'g' })
  const saved = JSON.parse(readFileSync(join(process.env.ANTON_HOME, 'runs.json'), 'utf8'))
  assert.ok(saved[0].maxRounds >= 24 * 120)
  longrun.stopRun('main')
})

test('notes over the size limit get compressed first', async () => {
  const notes = join(process.env.ANTON_HOME, 'runs', 'main-notes.md')
  writeFileSync(notes, 'x'.repeat(60 * 1024))
  const seen = []
  longrun.setDeps({ ask: (p, { onDone }) => { seen.push(p); if (seen.length < 2) setTimeout(() => onDone('step', null), 0); return { ok: true } } })
  longrun.startRun({ session: 'main', hours: 5, goal: 'g' })
  for (let i = 0; i < 50 && seen.length < 2; i++) await tick(5)
  assert.match(seen[0], /Keep it compact, under about 40 KB/)
  assert.match(seen[1], /The notes are 60 KB, over the 40 KB limit: this round, first compress them/)
  longrun.stopRun('main')
})
