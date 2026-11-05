// Porch chains in this process (WORKER off): another agent's question gets a
// liaison answer, and a task that needs another agent asks it and then finishes.
// The results travel as deliver targets, as they do in the worker.
import { tick } from './setup.js'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { fakePorch } from './fixtures/fake-porch.js'

const porch = fakePorch({ agents: ['muse', 'grokbot'] })
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

// Porch 1010 (2026-11-04): Grokbot asked Anton, in 'general' and not as a question,
// to have another agent do work. It only waited for the next call. Now any post to
// Anton from another agent wakes the liaison, and a request for a named agent is
// handed to that agent right away.
test('a request (not a question) from another agent wakes the liaison and is handed to the named agent', async () => {
  const req = porch.add('grokbot', { room: 'general', to: ['anton'],
    text: 'Anton, request from Nithin: please have muse do a deep dive on VISTA [reply=ASK muse: grokbot asked: do a deep dive on VISTA]' })
  const handed = await until(() => porch.messages.find(m => m.from === 'anton' && m.to.includes('muse') && /deep dive on VISTA/.test(m.text)), 'the hand-off to muse')
  assert.ok(handed.id > req.id)
  const note = await until(() => porch.messages.find(m => m.from === 'anton' && m.reply_to === req.id), 'the note back to grokbot')
  assert.match(note.text, /checking with muse/)
})

test('a plain request with no named agent still wakes the liaison, which answers in the thread', async () => {
  const req = porch.add('grokbot', { room: 'general', to: ['anton'], text: 'Anton, please summarize what the research runs found' })
  const a = await until(() => porch.messages.find(m => m.from === 'anton' && m.reply_to === req.id), 'the liaison answer')
  assert.match(a.text, /^done \[A question from grokbot/)
})

test('a post from another agent NOT addressed to Anton does not wake the liaison', async () => {
  const before = porch.messages.length
  const p = porch.add('grokbot', { room: 'general', text: 'Note to self: check the hackathon page tomorrow' })
  await tick(400)
  assert.ok(!porch.messages.slice(before).some(m => m.from === 'anton' && m.reply_to === p.id))
})

test('an FYI post to Anton is not a request: no liaison, it stays on the call-gate path', async () => {
  const before = porch.messages.length
  const p = porch.add('grokbot', { room: 'general', to: ['anton'], text: 'Info only, no call needed: Nithin was approved for the hackathon.' })
  await tick(400)
  assert.ok(!porch.messages.slice(before).some(m => m.from === 'anton' && m.reply_to === p.id))
})
