import { fakeSocket, tick } from './setup.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { verifyWebhook, onWebhook } from '../src/sip.js'

const secret = process.env.OPENAI_WEBHOOK_SECRET
let n = 0

function signed(payload, { now = Date.now(), key = secret } = {}) {
  const body = JSON.stringify(payload)
  const id = `msg_${++n}`
  const ts = String(Math.floor(now / 1000))
  const sig = createHmac('sha256', Buffer.from(key.replace(/^whsec_/, ''), 'base64')).update(`${id}.${ts}.${body}`).digest('base64')
  return { headers: { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': `v1,${sig}` }, body }
}

const incoming = from => ({
  id: 'evt_1',
  type: 'live.transport.incoming',
  data: {
    type: 'sip',
    session_id: 'live_test_1',
    sip_media_security: 'srtp',
    sip_headers: [{ name: 'From', value: `<sip:${from}@trunk.example>;tag=1` }, { name: 'To', value: '<sip:anton@example>' }],
  },
})

function stubs() {
  const requests = []
  const sockets = []
  return {
    requests,
    sockets,
    fetchFn: async (url, opts) => { requests.push({ url, body: opts.body ? JSON.parse(opts.body) : null }); return { ok: true, status: 200, text: async () => '' } },
    connect: url => { const ws = fakeSocket(); ws.url = url; sockets.push(ws); return ws },
    makeTools: () => ({ run: async () => ({ ok: true }), blocked: () => false, userSpoke() {}, outside() {} }),
  }
}

test('webhook signatures: good, wrong key, stale, missing', () => {
  const ok = signed({ a: 1 })
  assert.equal(verifyWebhook(ok.headers, ok.body, secret), true)
  const wrong = signed({ a: 1 }, { key: 'whsec_' + Buffer.from('other').toString('base64') })
  assert.equal(verifyWebhook(wrong.headers, wrong.body, secret), false)
  const stale = signed({ a: 1 }, { now: Date.now() - 10 * 60e3 })
  assert.equal(verifyWebhook(stale.headers, stale.body, secret), false)
  assert.equal(verifyWebhook({}, ok.body, secret), false)
  assert.equal(verifyWebhook(ok.headers, ok.body + ' ', secret), false, 'a changed body fails')
})

test('an unsigned webhook is refused and nothing is called', async () => {
  const s = stubs()
  const status = await onWebhook({ 'webhook-id': 'x', 'webhook-timestamp': '1', 'webhook-signature': 'v1,bad' }, '{}', s)
  assert.equal(status, 401)
  assert.equal(s.requests.length, 0)
})

test('a call from the owner is accepted with GPT-Live settings, then driven over the sideband', async () => {
  const s = stubs()
  const { headers, body } = signed(incoming('+15550001111'))
  assert.equal(await onWebhook(headers, body, s), 200)
  assert.equal(s.requests.length, 1)
  assert.equal(s.requests[0].url, 'https://live.test/v1/live/sessions/live_test_1/accept')
  const session = s.requests[0].body.session
  assert.equal(session.type, 'live')
  assert.equal(session.model, 'gpt-live-1')
  assert.equal(session.audio.format, undefined)
  assert.equal(session.delegation.type, 'responses')
  assert.equal(s.sockets.length, 1)
  assert.equal(s.sockets[0].url, 'wss://live.test/v1/live/sessions/live_test_1/attach')
  assert.equal(s.sockets[0].ofType('session.start').length, 0, 'the sideband never sends session.start')
  s.sockets[0].event({ type: 'session.closed' })
  await tick(5)
})

test('the same delivery twice is handled once', async () => {
  const s = stubs()
  const d = signed(incoming('+15550001111'))
  await onWebhook(d.headers, d.body, s)
  await onWebhook(d.headers, d.body, s)
  assert.equal(s.requests.length, 1)
  s.sockets[0].event({ type: 'session.closed' })
  await tick(5)
})

test('a call from another number is rejected', async () => {
  const s = stubs()
  const { headers, body } = signed(incoming('+15559998888'))
  assert.equal(await onWebhook(headers, body, s), 200)
  assert.equal(s.requests.length, 1)
  assert.match(s.requests[0].url, /\/live_test_1\/reject$/)
  assert.equal(s.sockets.length, 0)
})
