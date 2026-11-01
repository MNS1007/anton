// Test settings, set before any Anton module loads its config, so tests never
// touch ~/.anton, porch, or the phone. Import this first in every test file.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'

Object.assign(process.env, {
  ANTON_HOME: mkdtempSync(join(tmpdir(), 'anton-test-')),
  USER_NAME: 'Sam',
  MY_NUMBER: '+15550001111',
  OPENAI_API_KEY: 'sk-test',
  OPENAI_WEBHOOK_SECRET: 'whsec_' + Buffer.from('test-secret-key').toString('base64'),
  LIVE_URL: 'https://live.test/v1/live/sessions',
  PORCH_URL: 'off',
  PORCH_TOKEN: 'off',
})
// An empty value would let a developer's .env fill it back in.
process.env.PORCH_URL = ''
process.env.PORCH_TOKEN = ''

// A stand-in for a WebSocket: records what Anton sends, lets the test send events.
export function fakeSocket() {
  const ws = new EventEmitter()
  ws.readyState = 1
  ws.sent = []
  ws.send = raw => ws.sent.push(JSON.parse(raw))
  ws.close = () => { ws.readyState = 3 }
  ws.event = ev => ws.emit('message', JSON.stringify(ev))
  ws.ofType = type => ws.sent.filter(m => m.type === type)
  return ws
}

export const tick = (ms = 0) => new Promise(r => setTimeout(r, ms))
