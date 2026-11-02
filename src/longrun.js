// Long runs: keep one Claude session working toward a goal for hours.
// A single Claude task ends when Claude thinks it is done, usually well under an
// hour. A long run gives the session its next step again and again until the time
// is up or the session says the work is complete. The session keeps working notes
// in a file it reads every round, so nothing is lost between rounds. Rounds are
// quiet; the user hears once, when the run ends. Runs survive a restart.
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './config.js'
import { log } from './log.js'
import * as agent from './agent.js'

const DONE = 'RUN COMPLETE'
const file = () => join(config.antonHome, 'runs.json')
const runs = new Map() // session -> { session, goal, until, rounds, notes, last, maxRounds }

// pause: the gap between rounds. Back-to-back rounds burn through a Claude plan's
// usage limit in a few hours; a gap gives fewer, deeper rounds.
let deps = { ask: agent.ask, notify: () => {}, now: () => Date.now(), pause: config.longRunGapMinutes * 60e3, retry: 60e3, later: (fn, ms) => setTimeout(fn, ms) }

// "You've hit your 5-hour limit · resets 12:30am (America/Los_Angeles)": how long
// to wait. A couple of minutes past the reset, or half an hour if no time is given.
export function limitWait(message, now = new Date()) {
  if (!/limit|rate.?limit|usage/i.test(message) || !/hit|reached|exceeded|resets/i.test(message)) return 0
  const m = /resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(message)
  if (!m) return 30 * 60e3
  let h = Number(m[1]) % 12
  if (m[3].toLowerCase() === 'pm') h += 12
  const at = new Date(now)
  at.setHours(h, Number(m[2] || 0), 0, 0)
  if (at <= now) at.setDate(at.getDate() + 1)
  return at - now + 2 * 60e3
}
export function setDeps(d) { deps = { ...deps, ...d } }

function save() {
  try {
    mkdirSync(config.antonHome, { recursive: true })
    writeFileSync(file(), JSON.stringify([...runs.values()], null, 1))
  } catch (err) { log(`could not save runs: ${err.message}`) }
}

const hoursLeft = r => Math.max(0, (r.until - deps.now()) / 3600e3)

// Notes are read in full every round, so they must stay small.
const NOTES_KB = 40
const notesKB = r => { try { return Math.round(statSync(r.notes).size / 1024) } catch { return 0 } }
const notesStamp = r => { try { const s = statSync(r.notes); return `${s.size}:${s.mtimeMs}` } catch { return '' } }

function prompt(r) {
  const left = hoursLeft(r)
  // The final round has to start while there is still time for one more round.
  const perRound = r.rounds ? (deps.now() - r.started) / r.rounds / 3600e3 : 0
  const last = left < Math.max(0.5, perRound * 1.2)
  // Every round is a fresh conversation (a long-resumed one starts repeating
  // itself), so each prompt carries the goal and the rules, and the notes carry
  // everything learned so far.
  const head = `[Long run from ${config.userName}, round ${r.rounds + 1}. About ${left.toFixed(1)} hours of the run are left. Work on your own; nobody is waiting on each step. This round is a fresh conversation: all the work so far is in your notes, so read them first.]

Goal:
${r.goal}

Your working notes are ${r.notes}${r.rounds === 0 ? ' (start them now)' : ''}: what you have learned, what you are pursuing, what you ruled out and why, and what to do next. Read them at the start of the round and update them at the end. Keep them compact, under about ${NOTES_KB} KB: the current best answer first, then open threads; fold older round-by-round detail into a short log instead of letting it grow. This round, pick the single most valuable next step, do it well, update the notes, and stop. You will be called again for the next round.

If something needs ${config.userName}'s approval (money, downloads, contacting people, account changes), do not wait for it and do not stop: write it under a "## Waiting on ${config.userName}" heading in the notes, with what you would do and why, and move on to the next most valuable thing you can do without it.${notesKB(r) > NOTES_KB ? `\n\nThe notes are ${notesKB(r)} KB, over the ${NOTES_KB} KB limit: this round, first compress them (keep the best answer, scoreboard, open threads and the reasons ideas died; fold the rest into a short log), then continue.` : ''}`
  const idle = !last && (r.idle || 0) >= 2
    ? `\n\nThe last ${r.idle} rounds left the notes unchanged, which wastes the run. No waiting, no scheduled checkpoints, no "nothing new" rounds. This round, do real work: bring in a new candidate from a space not yet considered, check the strongest objection to the best answer against a primary source, or make the best answer concretely better. Then update the notes.`
    : ''
  const end = idle + (last
    ? `\n\nTime is almost up. Write the final result now: update the notes, then reply with a summary ${config.userName} can act on, and end your reply with ${DONE}.`
    : r.stopEarly
      ? `\n\nIf the goal is fully met and more rounds would not improve it, write the final result into the notes, reply with a summary, and end your reply with ${DONE}.`
      : `\n\nThis run lasts the full time; there is no finishing early. If your current answer feels done, use the round to make it stronger: test the strongest objection, look for a better idea you have not considered, check a claim against a primary source, or widen the search. Keep the current best answer at the top of the notes.`)
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
    fresh: true,
    onDone: (result, failed) => {
      r.rounds++
      r.last = String(result || failed || '').slice(-4000)
      save()
      if (failed) {
        const why = String(failed)
        if (why.includes('stopped')) return finish(r, 'it was stopped')
        r.rounds-- // a failed round did no work
        // Out of plan usage: wait for the reset, then carry on.
        const wait = limitWait(why, new Date(deps.now()))
        if (wait && deps.now() + wait < r.until) {
          log(`[${r.session}] long run paused for ${Math.round(wait / 60e3)} min: ${why.slice(0, 120)}`)
          deps.notify({ kind: 'note', ring: false, session: r.session, text: `The long run in ${r.session} hit the Claude usage limit and is paused until about ${new Date(deps.now() + wait).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}. It carries on by itself after that.` })
          return deps.later(() => round(r), wait)
        }
        // Anything else gets a few tries before the run gives up.
        r.failures = (r.failures || 0) + 1
        if (!wait && r.failures <= 3) return deps.later(() => round(r), deps.retry * r.failures)
        return finish(r, `a round failed: ${why.slice(0, 200)}`)
      }
      r.failures = 0
      if (String(result).includes(DONE) && (r.stopEarly || hoursLeft(r) <= 0.5)) return finish(r, 'the session finished the goal')
      shareAsks(r)
      // A round that leaves the notes untouched did no work. Count them.
      const stamp = notesStamp(r)
      r.idle = stamp && stamp === r.stamp ? (r.idle || 0) + 1 : 0
      r.stamp = stamp
      setTimeout(() => round(r), deps.pause)
    },
  })
  if (!res.ok) finish(r, res.reason)
}

// New asks under "Waiting on <user>" in the notes reach the user without a call:
// when a new item appears, or at most every few hours when only the wording moved.
const ASK_EVERY_MS = 4 * 3600e3
const items = text => text.split('\n').filter(l => /^\s*(\d+[.)]|[-*])\s/.test(l)).length
function shareAsks(r) {
  let notes = ''
  try { notes = readFileSync(r.notes, 'utf8') } catch { return }
  const start = notes.search(new RegExp(`^##\\s*Waiting on ${config.userName}`, 'im'))
  if (start < 0) return
  const body = notes.slice(start).split('\n').slice(1).join('\n')
  const asks = body.split(/\n## /)[0].trim()
  if (!asks || asks === r.asks) return
  const more = items(asks) > items(r.asks || '')
  if (!more && r.asksAt && deps.now() - r.asksAt < ASK_EVERY_MS) return
  r.asks = asks
  r.asksAt = deps.now()
  save()
  deps.notify({ kind: 'note', ring: false, session: r.session, text: `The long run in ${r.session} is waiting on you for: ${asks.slice(0, 1500)} It keeps working on other things meanwhile.` })
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

// stopEarly: let the session end the run when it thinks the goal is met. Off by
// default: a run asked to last 24 hours lasts 24 hours unless someone stops it.
// maxRounds is only a safety net against a broken loop; by default it allows one
// round every 30 seconds for the whole run, so fast rounds never end a run early.
export function startRun({ session, hours, goal, maxRounds, stopEarly = false }) {
  const s = agent.status(session)
  if (!s.name) return { ok: false, reason: `No session named ${session}. Create it first.` }
  if (s.porchAgent) return { ok: false, reason: `${s.name} is another agent on porch; long runs are for Claude sessions Anton runs.` }
  if (runs.has(s.name)) return { ok: false, reason: `${s.name} already has a long run going. Stop it first.` }
  const h = Number(hours)
  if (!(h > 0 && h <= 72)) return { ok: false, reason: 'Give a length between a few minutes and 72 hours.' }
  if (!String(goal || '').trim()) return { ok: false, reason: 'Say what the run is for.' }
  const dir = join(config.antonHome, 'runs')
  mkdirSync(dir, { recursive: true })
  const r = { session: s.name, goal: String(goal), until: deps.now() + h * 3600e3, rounds: 0, started: deps.now(), notes: join(dir, `${s.name}-notes.md`), last: '', maxRounds: maxRounds || Math.max(200, Math.ceil(h * 120)), stopEarly: !!stopEarly }
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
