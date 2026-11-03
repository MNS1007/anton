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
  retry: 0,
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
  assert.match(prompts[0], /working notes are .*main-notes\.md/)
  assert.match(prompts[1], /round 2/)
  assert.match(prompts[1], /Goal:\nFind a venture-scale idea/, 'every round carries the goal: rounds are fresh conversations')
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

test('a failing round is retried three times, then the run ends and says why', async () => {
  reply = () => new Error('model overloaded')
  longrun.startRun({ session: 'main', hours: 10, goal: 'g' })
  await settle()
  assert.equal(prompts.length, 4, 'first try plus three retries')
  assert.match(notices.at(-1).text, /a round failed: model overloaded/)
})

test('hitting the plan usage limit pauses the run until the reset, then it carries on', async () => {
  const waits = []
  longrun.setDeps({ later: (fn, ms) => { waits.push(ms); clock += ms; setTimeout(fn, 0) } })
  // A reset an hour after the failing round, in local time like the real message.
  const resetAt = () => { const d = new Date(clock + 3600e3); const h = d.getHours(); return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}` }
  reply = n => n === 2 ? new Error(`You've hit your 5-hour limit · resets ${resetAt()} (America/Los_Angeles)`) : 'step'
  longrun.startRun({ session: 'main', hours: 6, goal: 'g' })
  await settle()
  assert.ok(waits.length === 1 && waits[0] > 0, 'waited once, for the reset')
  assert.ok(notices.some(n => /hit the Claude usage limit and is paused/.test(n.text) && n.ring === false))
  assert.match(notices.at(-1).text, /time is up/, 'and then ran to the end')
  longrun.setDeps({ later: (fn, ms) => setTimeout(fn, ms) })
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
  assert.match(seen[0], /Keep them compact, under about 40 KB/)
  assert.match(seen[0], /The notes are 60 KB, over the 40 KB limit: this round, first compress them/)
  longrun.stopRun('main')
})

test('rounds that leave the notes untouched get a push to do real work', async () => {
  const notes = join(process.env.ANTON_HOME, 'runs', 'main-notes.md')
  writeFileSync(notes, '# notes\n')
  const seen = []
  longrun.setDeps({ ask: (p, { onDone }) => { seen.push(p); if (seen.length < 4) setTimeout(() => onDone('nothing new', null), 0); return { ok: true } } })
  longrun.startRun({ session: 'main', hours: 10, goal: 'g' })
  for (let i = 0; i < 100 && seen.length < 4; i++) await tick(5)
  assert.doesNotMatch(seen[1], /left the notes unchanged/, 'one quiet round is fine')
  assert.match(seen[3], /The last 2 rounds left the notes unchanged/)
  longrun.stopRun('main')
})

test('a stopped run leaves no round behind: its timer does nothing once a new run has started', async () => {
  const timers = []
  const seen = []
  longrun.setDeps({
    next: fn => timers.push(fn),
    ask: (p, { onDone }) => { seen.push(p); setTimeout(() => onDone('step', null), 0); return { ok: true } },
  })
  longrun.startRun({ session: 'main', hours: 10, goal: 'the first goal' })
  for (let i = 0; i < 50 && !timers.length; i++) await tick(5)
  assert.equal(timers.length, 1, 'round 1 done, round 2 waits for its time')
  longrun.stopRun('main')
  longrun.startRun({ session: 'main', hours: 10, goal: 'the second goal' })
  for (let i = 0; i < 50 && timers.length < 2; i++) await tick(5)
  timers[0]() // the stopped run's timer fires
  await tick(5)
  assert.deepEqual(seen.map(p => /the first goal/.test(p) ? 'first' : 'second'), ['first', 'second'], 'no second round for the stopped goal')
  longrun.stopRun('main')
  longrun.setDeps({ next: (fn, ms) => setTimeout(fn, ms) })
})

test('stopping a run whose round has not started yet drops that round', () => {
  const dropped = []
  longrun.setDeps({ ask: () => ({ ok: true, queued: 1 }), dropRounds: s => dropped.push(s) })
  longrun.startRun({ session: 'main', hours: 2, goal: 'g' })
  assert.equal(longrun.stopRun('main').ok, true)
  assert.deepEqual(dropped, ['main'])
  longrun.setDeps({ dropRounds: () => {} })
})
