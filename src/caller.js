// Holds updates for the user and makes sure they hear them:
// tell them on the live call, or call them, and call again until they pick up.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import twilio from 'twilio'
import { config } from './config.js'
import { log } from './log.js'
import { agent } from './runner.js'

let twilioClient = null
const client = () => (twilioClient ??= twilio(config.twilioSid, config.twilioToken))

let queue = []          // updates not yet heard by the user
const latest = new Map() // session:note -> the queued text it replaces next time
let active = null       // live call bridge: { inject(text), callSid }
let outbound = null     // { sid, connected }
let retryTimer = null
let attempts = 0

// With the worker, a notice the front has taken is gone from the worker's outbox,
// so updates not heard yet are also kept in a file (keepIn) and read back when
// the front starts again. Off (null) without the worker. Call it once calls can
// be placed (the public url is known): updates that wanted a call get one.
let store = null
let telling = []      // told on the current call; heard once the user speaks
let wantCall = false  // an update asked for a call that has not been heard yet

export function keepIn(file) {
  store = file
  let saved = null
  try { saved = JSON.parse(readFileSync(file, 'utf8')) } catch {}
  const earlier = Array.isArray(saved?.updates) ? saved.updates : []
  queue = [...earlier, ...queue]
  if (earlier.length) log(`${earlier.length} update(s) from before the restart are waiting to be heard`)
  if (saved?.ring && earlier.length) wantCall = true
  save()
  if (wantCall && queue.length && !active && !outbound && !retryTimer) tryDial()
}

function save() {
  if (!store) return
  const updates = [...telling, ...queue]
  try { writeFileSync(store, JSON.stringify({ updates, ring: wantCall && updates.length > 0 })) } catch (err) { log(`could not keep the updates: ${err.message}`) }
}

// A promised callback: the sessions the user is waiting on. Their results are
// held, and one call goes out when the last of them finishes.
let callback = null // { waiting: Set<session>, note }

export function callBackWhenDone(sessions, note = '') {
  const waiting = new Set(sessions)
  if (!waiting.size) return { ok: false, reason: 'Nothing is running, so there is nothing to wait for.' }
  callback = { waiting, note }
  log(`will call back when ${[...waiting].join(', ')} finish`)
  return { ok: true, waiting: [...waiting], note: `I will call when ${[...waiting].join(', ')} ${waiting.size > 1 ? 'have all' : 'has'} finished.` }
}

export const pendingCallback = () => callback && { waiting: [...callback.waiting], note: callback.note }

const finishes = notice => notice.kind === 'done' || notice.kind === 'failed'

// Places the call; tests swap it out so nothing is dialled.
let dial = () => placeCall()
export function setDialer(fn) { dial = fn }

// "Don't call me for 45 minutes": no call of any kind before the time the user set,
// not for a finished task, a promised callback or a permission question. Held updates
// wait and one call goes out when it ends. Kept in a file, so a restart keeps it, and
// only the user can set or clear it (dont_call is a user-only tool on calls).
const dontCallFile = () => join(config.antonHome, 'dont-call.json')
export function dontCallUntil(now = Date.now()) {
  try {
    const d = JSON.parse(readFileSync(dontCallFile(), 'utf8'))
    return Number(d.until) > now ? { until: Number(d.until), reason: d.reason || '' } : null
  } catch { return null }
}
export function dontCall(minutes, reason = '') {
  const m = Number(minutes) || 0
  const until = m > 0 ? Date.now() + m * 60000 : 0
  try { writeFileSync(dontCallFile(), JSON.stringify({ until, reason, set: Date.now() })) } catch (err) { return { ok: false, reason: err.message } }
  // Re-plan any call that was waiting: later if now blocked, now if just cleared.
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
  if (wantCall && queue.length && !active && !outbound) tryDial()
  if (!until) { log('do-not-call cleared'); return { ok: true, note: 'Calls are allowed again.' } }
  const at = new Date(until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  log(`do not call until ${at}${reason ? ` (${reason})` : ''}`)
  return { ok: true, until: at, note: `No calls until ${at}, even if work finishes or Claude needs permission. Anything new waits for one call then.` }
}
function tryDial() {
  const d = dontCallUntil()
  if (d) {
    if (!retryTimer) {
      log(`do-not-call until ${new Date(d.until).toLocaleTimeString()}; the call waits`)
      retryTimer = setTimeout(() => { retryTimer = null; if (wantCall && queue.length && !active && !outbound) tryDial() }, d.until - Date.now() + 1000)
    }
    return
  }
  dial()
}
export const heldUpdates = () => [...queue]

// ring: false keeps the update for the next call without placing one.
export function notify(notice) {
  log(`update: ${notice.kind}`)
  if (active) {
    if (callback && finishes(notice)) callback.waiting.delete(notice.session)
    if (callback && !callback.waiting.size) callback = null
    active.inject(notice.text)
    return save()
  }
  // A newer note from the same session replaces the older one, so a call does not
  // open with four versions of the same update.
  if (notice.kind === 'note' && notice.session) {
    const key = `${notice.session}:note`
    if (latest.has(key)) queue = queue.filter(t => t !== latest.get(key))
    latest.set(key, notice.text)
  }
  queue.push(notice.text)
  let ring = notice.ring !== false
  if (callback && finishes(notice) && callback.waiting.has(notice.session)) {
    callback.waiting.delete(notice.session)
    if (callback.waiting.size) {
      log(`holding ${notice.session}'s result; still waiting on ${[...callback.waiting].join(', ')}`)
      ring = false
    } else {
      queue.unshift(`You asked me to call when this was done${callback.note ? ` (${callback.note})` : ''}.`)
      callback = null
    }
  } else if (callback && notice.kind !== 'permission') {
    // Other news waits for the promised call, unless it needs the user's answer.
    ring = false
  }
  if (ring) wantCall = true
  save()
  if (ring && !outbound && !retryTimer) tryDial()
}

// Called by the bridge when a call connects. Returns what to tell the user first.
export function callStarted(bridge) {
  active = bridge
  if (outbound && bridge.callSid === outbound.sid) outbound.connected = true
  clearTimeout(retryTimer)
  retryTimer = null
  const updates = queue
  queue = []
  telling = updates
  save()
  return updates
}

// userSpoke: the user said something, so we count the updates as heard.
export function callEnded({ userSpoke, updates }) {
  active = null
  if (outbound) outbound = null
  telling = []
  if (!userSpoke) {
    queue = [...updates, ...queue]
    log('call ended with no answer from the user')
  } else {
    attempts = 0
    if (!queue.length) wantCall = false
  }
  save()
  if (queue.length || agent.hasPendingPermission()) {
    if (userSpoke && agent.hasPendingPermission() && !queue.length) {
      const waits = agent.pendingPermissions().map(p => `${p.session}: ${p.summary}`).join('; ')
      queue.push(`Reminder: Claude is still waiting for your answer. ${waits}`)
    }
    scheduleRetry()
  }
}

// Twilio status callback for calls we placed.
export function callStatus(sid, status) {
  if (!outbound || outbound.sid !== sid) return
  if (status === 'completed' && outbound.connected) return // the bridge handles it
  if (['completed', 'busy', 'no-answer', 'failed', 'canceled'].includes(status)) {
    log(`call not answered (${status})`)
    outbound = null
    scheduleRetry()
  }
}

function scheduleRetry() {
  if (retryTimer) return
  if (config.maxAttempts && attempts >= config.maxAttempts) {
    log(`gave up after ${attempts} calls; updates wait for the next call in or out`)
    return
  }
  const ms = config.retryMinutes * 60000
  log(`calling again in ${config.retryMinutes} min`)
  retryTimer = setTimeout(() => { retryTimer = null; placeCall() }, ms)
}

async function placeCall() {
  if (active || outbound) return
  const dc = dontCallUntil()
  const wait = Math.max(msUntilQuietEnds(), dc ? dc.until - Date.now() + 1000 : 0)
  if (wait > 0) {
    log(`${dc ? 'do-not-call' : 'quiet hours'}; calling in ${Math.round(wait / 60000)} min`)
    retryTimer = setTimeout(() => { retryTimer = null; placeCall() }, wait)
    return
  }
  attempts++
  try {
    const call = await client().calls.create({
      to: config.myNumber,
      from: config.twilioNumber,
      url: `${config.publicUrl}/voice`,
      statusCallback: `${config.publicUrl}/status`,
      statusCallbackEvent: ['completed'],
      machineDetection: 'Enable',
      timeout: 30,
    })
    outbound = { sid: call.sid, connected: false }
    log(`calling you (attempt ${attempts})`)
  } catch (err) {
    log(`could not place call: ${err.message}`)
    scheduleRetry()
  }
}

export async function hangUp(callSid) {
  try { await client().calls(callSid).update({ status: 'completed' }) } catch (err) { log(`hang up failed: ${err.message}`) }
}

// QUIET_HOURS like "22-7" means no calls from 22:00 to 07:00 local time.
function msUntilQuietEnds() {
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(config.quietHours)
  if (!m) return 0
  const [start, end] = [Number(m[1]), Number(m[2])]
  const now = new Date()
  const h = now.getHours()
  const quiet = start < end ? h >= start && h < end : h >= start || h < end
  if (!quiet) return 0
  const until = new Date(now)
  until.setHours(end, 0, 0, 0)
  if (until <= now) until.setDate(until.getDate() + 1)
  return until - now
}
