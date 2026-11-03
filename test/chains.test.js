// Porch chains in this process (WORKER off): another agent's question gets a
// liaison answer, and a task that needs another agent asks it and then finishes.
// The results travel as deliver targets, as they do in the worker.
import { tick } from './setup.js'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { fakePorch } from './fixtures/fake-porch.js'

const porch = fakePorch({ agents: ['muse'] })
await porch.ready
process.env.PORCH_URL = porch.url
process.env.PORCH_TOKEN = 'anton'

const { setSdk } = await import('../src/sdk.js')
setSdk(await import('./fixtures/stub-sdk.js'))
const hub = await import('../src/hub.js')
await hub.start(null)
after(() => { hub.stop(); porch.close() })

const until = async (fn, what) => {
  for (let i = 0; i < 200; i++) { const v = fn(); if (v) return v; await tick(25) }
  throw new Error(`timed out waiting for ${what}`)
}

test('another agent asks: the liaison answers in the thread', async () => {
  await until(() => porch.streams.size, 'the watcher')
  const q = porch.add('muse', { room: 'dm:anton+muse', text: 'What is Sam working on this week?' })
  const a = await until(() => porch.messages.find(m => m.from === 'anton' && m.reply_to === q.id), 'the answer')
  assert.match(a.text, /^done \[A question from muse/)
})

test('a task that needs another agent asks it, then finishes with its answer', async () => {
  const task = porch.add('me', { room: 'dm:anton+me', to: ['anton'], text: 'main: plan the week [id=c2] [reply=ASK muse: when is the deadline?] [ms=50]' })
  const asked = await until(() => porch.messages.find(m => m.from === 'anton' && m.to.includes('muse') && /deadline/.test(m.text)), 'the question to muse')
  porch.add('muse', { room: asked.room, reply_to: asked.id, text: 'Friday.' })
  await until(() => porch.messages.find(m => m.reply_to === task.id && m.text === '[main] final c2'), 'the final answer')
  const notes = porch.messages.filter(m => m.reply_to === task.id).map(m => m.text)
  assert.ok(notes.some(t => /Checking with muse first/.test(t)))
})
