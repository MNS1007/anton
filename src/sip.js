// Calls that reach OpenAI over SIP (a Twilio SIP trunk pointed at sip.api.openai.com).
// OpenAI has the audio; Anton gets a webhook, accepts the call with the session
// settings, and drives it over the sideband WebSocket. No media passes through here.
import { createHmac, timingSafeEqual } from 'node:crypto'
import WebSocket from 'ws'
import { config } from './config.js'
import { log } from './log.js'
import { liveCall, sessionConfig } from './live.js'

const seen = new Map() // webhook-id -> time, so a redelivered webhook is handled once
const api = path => config.liveUrl + path
const auth = () => ({ Authorization: `Bearer ${config.openaiKey}`, 'Content-Type': 'application/json' })

// Standard Webhooks signature: base64 HMAC-SHA256 of "id.timestamp.body",
// keyed with the secret after "whsec_". The header may carry several "v1,<sig>".
export function verifyWebhook(headers, body, secret, now = Date.now()) {
  const id = headers['webhook-id']
  const ts = headers['webhook-timestamp']
  const sigs = String(headers['webhook-signature'] || '')
  if (!id || !ts || !sigs || !secret) return false
  if (Math.abs(now / 1000 - Number(ts)) > 300) return false
  const key = Buffer.from(String(secret).replace(/^whsec_/, ''), 'base64')
  const expected = createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest()
  return sigs.split(' ').some(s => {
    const [v, sig] = s.split(',')
    if (v !== 'v1' || !sig) return false
    const got = Buffer.from(sig, 'base64')
    return got.length === expected.length && timingSafeEqual(got, expected)
  })
}

const sameNumber = (a, b) => String(a).replace(/\D/g, '').endsWith(String(b).replace(/\D/g, '').slice(-10))

// Handles one webhook delivery. Returns the HTTP status to answer with.
export async function onWebhook(headers, body, { fetchFn = fetch, connect = url => new WebSocket(url, { headers: auth() }), makeTools } = {}) {
  if (!verifyWebhook(headers, body, config.openaiWebhookSecret)) {
    log('rejected an unsigned OpenAI webhook')
    return 401
  }
  const id = headers['webhook-id']
  if (seen.has(id)) return 200
  seen.set(id, Date.now())
  for (const [k, t] of seen) if (Date.now() - t > 3600e3) seen.delete(k)

  let ev
  try { ev = JSON.parse(body) } catch { return 400 }
  if (ev.type !== 'live.transport.incoming' || ev.data?.type !== 'sip') return 200
  const sessionId = ev.data.session_id
  // SIP headers are only what the caller's side claims. The trunk's own allow list
  // is the real gate; this check keeps strangers off if the trunk is open.
  const from = (ev.data.sip_headers || []).find(h => /^from$/i.test(h.name))?.value || ''
  if (config.myNumber && !sameNumber(from.replace(/^.*?sip:|@.*$/g, ''), config.myNumber)) {
    log('rejected a SIP call from an unknown number')
    await fetchFn(api(`/${sessionId}/reject`), { method: 'POST', headers: auth(), body: JSON.stringify({ status_code: 403 }) }).catch(() => {})
    return 200
  }

  const call = liveCall({
    callSid: sessionId,
    makeTools,
    hangUp: () => fetchFn(api(`/${sessionId}/hangup`), { method: 'POST', headers: auth() }).catch(err => log(`hangup: ${err.message}`)),
  })
  const r = await fetchFn(api(`/${sessionId}/accept`), { method: 'POST', headers: auth(), body: JSON.stringify({ session: sessionConfig(call.updates, { sip: true }) }) })
  if (!r.ok) {
    log(`could not accept the SIP call: ${r.status} ${await r.text().catch(() => '')}`)
    call.end()
    return 200
  }
  log('SIP call accepted (GPT-Live)')
  call.attach(connect(api(`/${sessionId}/attach`).replace(/^http/, 'ws')), { start: false })
  return 200
}
