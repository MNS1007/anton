import http from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { spawn } from 'node:child_process'
import { openSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import twilio from 'twilio'
import { config, checkConfig, dotenvNames } from './config.js'
import { log } from './log.js'
import * as local from './agent.js'
import { agent, use } from './runner.js'
import * as client from './worker-client.js'
import { workerSecret } from './worker-secret.js'
import * as caller from './caller.js'
import { handleCall } from './bridge.js'
import { handleLiveCall } from './live.js'
import * as sip from './sip.js'
import { startTunnel, pointNumberAt } from './tunnel.js'
import * as hub from './hub.js'
import * as memory from './memory.js'
import * as reflection from './reflect.js'
import * as longrun from './longrun.js'
import * as vault from './vault.js'

const { phone } = checkConfig()

// WORKER=on: Claude runs in the worker (src/worker.js), which keeps working when
// this process restarts. This side keeps the phone and talks to it over its API.
if (config.worker) use(client, { isRemote: true })

// Updates go to the phone, and to porch when it is set up. With the worker,
// porch relays go out from the worker and updates reach here through /notify.
function notify(notice) {
  if (phone) caller.notify(notice)
  if (hub.enabled && !config.worker) hub.relay(notice)
}
if (!config.worker) {
  local.onNotify(notify)
  longrun.setDeps({ notify })
  local.setContext(() => memory.context({ calls: false }))
  local.onFinish(memory.logTask)
}

// The media stream path carries a secret so only calls we answered can open it.
const mediaToken = randomBytes(16).toString('hex')
const sameNumber = (a, b) => String(a).replace(/\D/g, '').endsWith(String(b).replace(/\D/g, '').slice(-10))

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const body = req.method === 'POST' ? await readBody(req) : ''

  // Local only: lets scripts or hooks on this laptop make Anton call you.
  if (url.pathname === '/notify' && req.method === 'POST') {
    if (!isLocal(req)) return send(res, 403, 'forbidden')
    if (req.headers['x-worker-secret']) return fromWorker(req, res, body)
    if (config.worker) {
      // A script's notice goes through the worker, so porch gets it too.
      let text = body
      try { text = JSON.parse(body).message || body } catch {}
      const r = await client.notice({ text: String(text).slice(0, 2000) })
      if (!r?.ok && phone) caller.notify({ kind: 'note', text: String(text).slice(0, 2000) })
      return send(res, 200, 'ok')
    }
    let text = body
    try { text = JSON.parse(body).message || body } catch {}
    notify({ kind: 'note', text: String(text).slice(0, 2000) })
    return send(res, 200, 'ok')
  }

  if (phone && (url.pathname === '/voice' || url.pathname === '/status')) {
    const params = Object.fromEntries(new URLSearchParams(body))
    const signature = req.headers['x-twilio-signature']
    if (!twilio.validateRequest(config.twilioToken, signature, config.publicUrl + req.url, params)) {
      log(`rejected unsigned request to ${url.pathname}`)
      return send(res, 403, 'forbidden')
    }

    if (url.pathname === '/status') {
      caller.callStatus(params.CallSid, params.CallStatus)
      return send(res, 200, 'ok')
    }

    const twiml = new twilio.twiml.VoiceResponse()
    const outbound = params.Direction?.startsWith('outbound')
    const caller_ = outbound ? params.To : params.From
    if (!sameNumber(caller_, config.myNumber)) {
      log('rejected a call from an unknown number')
      twiml.reject()
    } else if (params.AnsweredBy && params.AnsweredBy !== 'human' && params.AnsweredBy !== 'unknown') {
      log(`voicemail picked up (${params.AnsweredBy}); hanging up`)
      twiml.hangup()
    } else {
      const wsUrl = config.publicUrl.replace(/^http/, 'ws') + `/media/${mediaToken}`
      twiml.connect().stream({ url: wsUrl })
    }
    res.writeHead(200, { 'Content-Type': 'text/xml' })
    return res.end(twiml.toString())
  }

  // OpenAI calls this when a call reaches it over SIP. Checked by its signature.
  if (config.openaiWebhookSecret && url.pathname === '/live/incoming' && req.method === 'POST') {
    return send(res, await sip.onWebhook(req.headers, body).catch(err => { log(`SIP webhook: ${err.message}`); return 500 }), '')
  }

  if (url.pathname === '/health') return isLocal(req) ? send(res, 200, JSON.stringify(agent.status())) : send(res, 403, 'forbidden')
  send(res, 404, 'not found')
})

const wss = new WebSocketServer({ noServer: true })
server.on('upgrade', (req, socket, head) => {
  if (req.url !== `/media/${mediaToken}`) return socket.destroy()
  wss.handleUpgrade(req, socket, head, ws => (config.voiceEngine === 'live' ? handleLiveCall : handleCall)(ws))
})

server.listen(config.port, '127.0.0.1', async () => {
  log(`listening on http://127.0.0.1:${config.port}`)
  try {
    if (phone) {
      if (!config.publicUrl) config.publicUrl = await startTunnel(config.port)
      log(`public url: ${config.publicUrl}`)
      if (config.setWebhook) await pointNumberAt(`${config.publicUrl}/voice`)
    }
    if (config.worker) {
      // The worker counts a notice as delivered once this side has it, so what the
      // user has not heard yet is kept on disk here and survives a restart.
      if (phone) caller.keepIn(join(config.antonHome, 'unheard.json'))
      // The worker owns porch, reflection, the vault handles and long runs.
      await ensureWorker()
      await client.start()
      setInterval(() => ensureWorker().catch(() => {}), config.workerCheckMs).unref()
    } else {
      if (hub.enabled) await hub.start(phone ? caller.notify : null)
      // Vault handles for sessions the owner approved, in memory only.
      if (hub.enabled) vault.start()
      reflection.start()
      longrun.resume()
    }
  } catch (err) {
    log(`setup failed: ${err.message}`)
    process.exit(1)
  }
  if (phone) log(`${config.assistantName} is ready. Call ${config.twilioNumber}, or let it call you.`)
  if (hub.enabled) log(`On porch, post a message for ${config.porchBoss === 'me' ? 'Anton' : config.assistantName} to give Claude a task.`)
  log(`Claude works in ${config.workDir} (permission mode: ${config.permissionMode})${config.worker ? ', in the worker' : ''}`)
})

// The worker's outbox. Each notice has an id; one seen before is not passed on
// again (the worker retries when it did not hear back). Seen ids are kept on disk
// so a restart of this process does not ring twice either. The notice is queued
// (and kept on disk, see caller.keepIn) before its id is marked seen, so a kill in
// between can repeat it but never lose it.
const seenFile = join(config.antonHome, 'worker-seen.json')
let seen = null
function fromWorker(req, res, body) {
  const got = Buffer.from(String(req.headers['x-worker-secret']))
  const want = Buffer.from(workerSecret(config.antonHome))
  if (got.length !== want.length || !timingSafeEqual(got, want)) return send(res, 403, 'forbidden')
  let msg
  try { msg = JSON.parse(body) } catch { return send(res, 400, 'bad request') }
  if (!seen) { try { seen = JSON.parse(readFileSync(seenFile, 'utf8')) } catch { seen = [] } }
  const id = String(msg.outbox || '')
  if (!id || !msg.notice?.text) return send(res, 400, 'bad request')
  if (seen.includes(id)) return send(res, 200, 'seen')
  if (phone) caller.notify(msg.notice)
  seen = [...seen, id].slice(-2000)
  writeFileSync(seenFile, JSON.stringify(seen))
  log(`worker notice ${id}: ${msg.notice.kind}`)
  send(res, 200, 'ok')
}

// The supervisor: start the worker if it does not answer, check it every
// WORKER_CHECK_MS (15 s), and start it again if it died. It runs detached, so
// stopping or restarting this process never stops it.
const workerFile = fileURLToPath(new URL('./worker.js', import.meta.url))
let starting = null
function ensureWorker() {
  starting ??= (async () => {
    if (await client.health()) return true
    log('starting the worker')
    const out = openSync(join(config.antonHome, 'worker.log'), 'a')
    // The worker reads .env itself, so it knows which names came from there.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !dotenvNames.includes(k)))
    spawn(process.execPath, [workerFile], { cwd: process.cwd(), env, detached: true, stdio: ['ignore', out, out], windowsHide: true }).unref()
    for (let i = 0; i < 80; i++) {
      await new Promise(r => setTimeout(r, 250))
      if (await client.health()) { log('worker is up'); return true }
    }
    log('the worker did not start; see worker.log in ANTON_HOME')
    return false
  })().finally(() => { starting = null })
  return starting
}

function readBody(req) {
  return new Promise(resolve => {
    let data = ''
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy() })
    req.on('end', () => resolve(data))
  })
}

function isLocal(req) {
  // Tunnels forward with these headers; a direct local request has none.
  if (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']) return false
  const a = req.socket.remoteAddress
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'
}

function send(res, code, text) {
  res.writeHead(code, { 'Content-Type': 'text/plain' })
  res.end(text)
}
