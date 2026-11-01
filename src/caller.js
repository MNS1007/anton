// Holds updates for the user and makes sure they hear them:
// tell them on the live call, or call them, and call again until they pick up.
import twilio from 'twilio'
import { config } from './config.js'
import { log } from './log.js'
import * as agent from './agent.js'

const client = twilio(config.twilioSid, config.twilioToken)

let queue = []          // updates not yet heard by the user
let active = null       // live call bridge: { inject(text), callSid }
let outbound = null     // { sid, connected }
let retryTimer = null
let attempts = 0

export function notify(notice) {
  log(`update: ${notice.kind}`)
  if (active) {
    active.inject(notice.text)
    return
  }
  queue.push(notice.text)
  if (!outbound && !retryTimer) placeCall()
}

// Called by the bridge when a call connects. Returns what to tell the user first.
export function callStarted(bridge) {
  active = bridge
  if (outbound && bridge.callSid === outbound.sid) outbound.connected = true
  clearTimeout(retryTimer)
  retryTimer = null
  const updates = queue
  queue = []
  return updates
}

// userSpoke: the user said something, so we count the updates as heard.
export function callEnded({ userSpoke, updates }) {
  active = null
  if (outbound) outbound = null
  if (!userSpoke) {
    queue = [...updates, ...queue]
    log('call ended with no answer from the user')
  } else {
    attempts = 0
  }
  if (queue.length || agent.hasPendingPermission()) {
    if (userSpoke && agent.hasPendingPermission() && !queue.length) {
      queue.push(`Reminder: Claude is still waiting for your answer. ${agent.status().waitingForPermission}`)
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
  const wait = msUntilQuietEnds()
  if (wait > 0) {
    log(`quiet hours; calling in ${Math.round(wait / 60000)} min`)
    retryTimer = setTimeout(() => { retryTimer = null; placeCall() }, wait)
    return
  }
  attempts++
  try {
    const call = await client.calls.create({
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
  try { await client.calls(callSid).update({ status: 'completed' }) } catch (err) { log(`hang up failed: ${err.message}`) }
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
