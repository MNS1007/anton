// Gives the local server a public https URL with a Cloudflare quick tunnel
// (no account needed), then points the Twilio number at it.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import twilio from 'twilio'
import { config } from './config.js'
import { log } from './log.js'

// The Windows installer does not always put cloudflared on PATH.
function cloudflaredPath() {
  if (process.env.CLOUDFLARED) return process.env.CLOUDFLARED
  const known = ['C:/Program Files (x86)/cloudflared/cloudflared.exe', 'C:/Program Files/cloudflared/cloudflared.exe']
  return (process.platform === 'win32' && known.find(p => existsSync(p))) || 'cloudflared'
}

export function startTunnel(port) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cloudflaredPath(), ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] })
    let found = false
    const onData = buf => {
      const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(buf.toString())
      if (m && !found) { found = true; resolve(m[0]) }
    }
    proc.stdout.on('data', onData)
    proc.stderr.on('data', onData)
    proc.on('error', err => reject(new Error(`could not start cloudflared (${err.message}). Install it, or set PUBLIC_URL.`)))
    proc.on('exit', code => {
      if (!found) reject(new Error(`cloudflared exited with code ${code}`))
      else { log('tunnel closed; restart Anton'); process.exit(1) }
    })
    process.on('exit', () => proc.kill())
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { proc.kill(); process.exit(0) })
  })
}

export async function pointNumberAt(voiceUrl) {
  const client = twilio(config.twilioSid, config.twilioToken)
  const [number] = await client.incomingPhoneNumbers.list({ phoneNumber: config.twilioNumber, limit: 1 })
  if (!number) throw new Error(`TWILIO_NUMBER ${config.twilioNumber} is not on this Twilio account`)
  // A number on a SIP trunk rings OpenAI directly (src/sip.js); its voice URL is not used.
  if (number.trunkSid) {
    log('Twilio number is on a SIP trunk, so incoming calls go to GPT-Live over SIP')
    return
  }
  // Update by sid: twilio 6 list results lose their sid and cannot update themselves.
  await client.incomingPhoneNumbers(number.sid).update({ voiceUrl, voiceMethod: 'POST' })
  log('Twilio number now points at this laptop')
}
