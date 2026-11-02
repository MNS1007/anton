// Long runs: keep one Claude session working toward a goal for hours.
// A single Claude task ends when Claude thinks it is done, usually well under an
// hour. A long run gives the session its next step again and again until the time
// is up or the session says the work is complete. The session keeps working notes
// in a file it reads every round, so nothing is lost between rounds. Rounds are
// quiet; the user hears once, when the run ends. Runs survive a restart.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './config.js'
import { log } from './log.js'
import * as agent from './agent.js'

const DONE = 'RUN COMPLETE'
const file = () => join(config.antonHome, 'runs.json')
const runs = new Map() // session -> { session, goal, until, rounds, notes, last, maxRounds }

let deps = { ask: agent.ask, notify: () => {}, now: () => Date.now(), pause: 5000 }
export function setDeps(d) { deps = { ...deps, ...d } }

function save() {
  try {
    mkdirSync(config.antonHome, { recursive: true })
    writeFileSync(file(), JSON.stringify([...runs.values()], null, 1))
  } catch (err) { log(`could not save runs: ${err.message}`) }
}

const hoursLeft = r => Math.max(0, (r.until - deps.now()) / 3600e3)

function prompt(r) {
  const left = hoursLeft(r)
  // The final round has to start while there is still time for one more round.
  const perRound = r.rounds ? (deps.now() - r.started) / r.rounds / 3600e3 : 0
  const last = left < Math.max(0.5, perRound * 1.2)
  const head = r.rounds === 0
    ? `[Long run from ${config.userName}: you have about ${left.toFixed(1)} hours for this. Work on your own; nobody is waiting on each step.]

Goal:
${r.goal}

Keep your working notes in ${r.notes}: what you have learned, what you are pursuing, what you ruled out and why, and what to do next. Read it at the start of every round and update it at the end. Each round, pick the single most valuable next step, do it well, and stop. You will be called again for the next round.`
    : `[Long run, round ${r.rounds + 1}. About ${left.toFixed(1)} hours left.] Read ${r.notes}, pick the most valuable next step toward the goal, do it, and update the notes.`
  const end = last
    ? `\n\nTime is almost up. Write the final result now: update the notes, then reply with a summary ${config.userName} can act on, and end your reply with ${DONE}.`
    : `\n\nIf the goal is fully met and more rounds would not improve it, write the final result into the notes, reply with a summary, and end your reply with ${DONE}.`
  return head + end
}

function round(r) {
  if (!runs.has(r.session)) return
  if (hoursLeft(r) <= 0) return finish(r, 'time is up')
  if (r.rounds >= r.maxRounds) return finish(r, `it reached ${r.maxRounds} rounds`)
  const res = deps.ask(prompt(r), {
    session: r.session,
    label: `long run, round ${r.rounds + 1}`,
    queue: true,
    onDone: (result, failed) => {
      r.rounds++
      r.last = String(result || failed || '').slice(-4000)
      save()
      if (failed) return finish(r, String(failed).includes('stopped') ? 'it was stopped' : `a round failed: ${String(failed).slice(0, 200)}`)
      if (String(result).includes(DONE)) return finish(r, 'the session finished the goal')
      setTimeout(() => round(r), deps.pause)
    },
  })
  if (!res.ok) finish(r, res.reason)
}

function finish(r, why) {
  if (!runs.delete(r.session)) return
  save()
  log(`[${r.session}] long run ended: ${why}`)
  deps.notify({
    kind: 'done',
    session: r.session,
    task: 'long run',
    text: `The long run in ${r.session} ended because ${why}, after ${r.rounds} round${r.rounds === 1 ? '' : 's'}. Notes are in ${r.notes}. Last reply: ${r.last.replace(DONE, '').trim().slice(0, 2500)}`,
  })
}

export function startRun({ session, hours, goal, maxRounds = 200 }) {
  const s = agent.status(session)
  if (!s.name) return { ok: false, reason: `No session named ${session}. Create it first.` }
  if (s.porchAgent) return { ok: false, reason: `${s.name} is another agent on porch; long runs are for Claude sessions Anton runs.` }
  if (runs.has(s.name)) return { ok: false, reason: `${s.name} already has a long run going. Stop it first.` }
  const h = Number(hours)
  if (!(h > 0 && h <= 72)) return { ok: false, reason: 'Give a length between a few minutes and 72 hours.' }
  if (!String(goal || '').trim()) return { ok: false, reason: 'Say what the run is for.' }
  const dir = join(config.antonHome, 'runs')
  mkdirSync(dir, { recursive: true })
  const r = { session: s.name, goal: String(goal), until: deps.now() + h * 3600e3, rounds: 0, started: deps.now(), notes: join(dir, `${s.name}-notes.md`), last: '', maxRounds }
  runs.set(r.session, r)
  save()
  log(`[${r.session}] long run started for ${h} hours`)
  round(r)
  return { ok: true, session: r.session, hours: h, notes: r.notes, note: `Running ${r.session} for ${h} hours. I will call when it ends.` }
}

export function stopRun(session) {
  const s = agent.status(session)
  const r = runs.get(s.name || session)
  if (!r) return { ok: false, reason: `No long run in ${session}.` }
  finish(r, 'you stopped it')
  if (agent.status(r.session).running) agent.stop(r.session)
  return { ok: true, session: r.session }
}

export function list() {
  return [...runs.values()].map(r => ({ session: r.session, goal: r.goal.slice(0, 200), hoursLeft: Number(hoursLeft(r).toFixed(1)), rounds: r.rounds, notes: r.notes }))
}

// After a restart: pick up runs whose time is not up yet.
export function resume() {
  let saved = []
  try { saved = JSON.parse(readFileSync(file(), 'utf8')) } catch {}
  for (const r of saved) {
    if (runs.has(r.session) || !agent.status(r.session).name) continue
    runs.set(r.session, r)
    log(`[${r.session}] long run resumed, ${hoursLeft(r).toFixed(1)} hours left`)
    round(r)
  }
}
