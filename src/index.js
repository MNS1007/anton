import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { WebSocketServer } from 'ws'
import twilio from 'twilio'
import { config, checkConfig } from './config.js'
import { log } from './log.js'
import * as agent from './agent.js'
import * as caller from './caller.js'
import { handleCall } from './bridge.js'
import { startTunnel, pointNumberAt } from './tunnel.js'

checkConfig()
agent.onNotify(caller.notify)

// The media stream path carries a secret so only calls we answered can open it.
const mediaToken = randomBytes(16).toString('hex')
const sameNumber = (a, b) => String(a).replace(/\D/g, '').endsWith(String(b).replace(/\D/g, '').slice(-10))

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const body = req.method === 'POST' ? await readBody(req) : ''

  // Local only: lets scripts or hooks on this laptop make Anton call you.
  if (url.pathname === '/notify' && req.method === 'POST') {
    if (!isLocal(req)) return send(res, 403, 'forbidden')
    let text = body
    try { text = JSON.parse(body).message || body } catch {}
    caller.notify({ kind: 'note', text: String(text).slice(0, 2000) })
    return send(res, 200, 'ok')
  }

  if (url.pathname === '/voice' || url.pathname === '/status') {
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

  if (url.pathname === '/health') return isLocal(req) ? send(res, 200, JSON.stringify(agent.status())) : send(res, 403, 'forbidden')
  send(res, 404, 'not found')
})

const wss = new WebSocketServer({ noServer: true })
server.on('upgrade', (req, socket, head) => {
  if (req.url !== `/media/${mediaToken}`) return socket.destroy()
  wss.handleUpgrade(req, socket, head, ws => handleCall(ws))
})

server.listen(config.port, '127.0.0.1', async () => {
  log(`listening on http://127.0.0.1:${config.port}`)
  try {
    if (!config.publicUrl) config.publicUrl = await startTunnel(config.port)
    log(`public url: ${config.publicUrl}`)
    if (config.setWebhook) await pointNumberAt(`${config.publicUrl}/voice`)
  } catch (err) {
    log(`setup failed: ${err.message}`)
    process.exit(1)
  }
  log(`${config.assistantName} is ready. Call ${config.twilioNumber}, or let it call you.`)
  log(`Claude works in ${config.workDir} (permission mode: ${config.permissionMode})`)
})

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
