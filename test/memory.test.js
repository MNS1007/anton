import './setup.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Porch "on" so the brief is shared; posting is stubbed, nothing is reached.
process.env.PORCH_URL = 'http://127.0.0.1:9'
process.env.PORCH_TOKEN = 'anton'
const memory = await import('../src/memory.js')
const reflection = await import('../src/reflect.js')
const dir = join(process.env.ANTON_HOME, 'memory')

const answer = (u, b) => `### UNDERSTANDING\n${u}\n### BRIEF\n${b}`

test('reflection rewrites the understanding from what Anton learned, and context uses it', async () => {
  memory.remember('Sam is moving Anton to GPT-Live this week.')
  let prompt = ''
  const out = await memory.reflect({ agentsDigest: '- muse (agent on porch): research briefings', askFn: async p => { prompt = p; return answer('## Goals now\n- Ship GPT-Live calls.', 'Sam is shipping voice calls; muse does research.') } })
  assert.equal(out.brief, 'Sam is shipping voice calls; muse does research.')
  assert.match(readFileSync(join(dir, 'understanding.md'), 'utf8'), /Ship GPT-Live calls/)
  assert.match(memory.context(), /current understanding of Sam:\n## Goals now/)
  assert.match(prompt, /moving Anton to GPT-Live/, 'notes are in the material')
  assert.match(prompt, /information about the agents only, never facts about Sam/)
  assert.match(prompt, /research briefings/)
  assert.equal(memory.lastReflection().brief, out.brief)
})

test('a reply without the two sections changes nothing', async () => {
  const before = readFileSync(join(dir, 'understanding.md'), 'utf8')
  assert.equal(await memory.reflect({ askFn: async () => 'sorry, no' }), null)
  assert.equal(readFileSync(join(dir, 'understanding.md'), 'utf8'), before)
})

test('the user\'s own edits to the understanding go into the next pass', async () => {
  writeFileSync(join(dir, 'understanding.md'), '## Goals now\n- Sam wants calls under 2 minutes.\n')
  let prompt = ''
  await memory.reflect({ askFn: async p => { prompt = p; return answer('## Goals now\n- Short calls.', 'b') } })
  assert.match(prompt, /calls under 2 minutes/)
})

test('forget removes matching lines from the understanding and keeps them out of later passes', async () => {
  writeFileSync(join(dir, 'understanding.md'), '## Projects\n- Sam is interviewing at Acme Robotics.\n- Anton voice work.\n')
  const r = memory.forget('interviewing at Acme Robotics')
  assert.equal(r.ok, true)
  const now = readFileSync(join(dir, 'understanding.md'), 'utf8')
  assert.doesNotMatch(now, /Acme/)
  assert.match(now, /Anton voice work/)
  let prompt = ''
  await memory.reflect({ askFn: async p => { prompt = p; return answer('x', 'y') } })
  assert.match(prompt, /Forgotten at Sam's request[^]*interviewing at Acme Robotics/)
})

test('due: something new and old enough, or a day has passed', () => {
  const since = Date.parse(memory.newSinceReflection().since || new Date().toISOString())
  assert.equal(reflection.due(since + 60e3), false, 'just reflected')
  memory.remember('Sam prefers updates by text after 9 pm.')
  assert.equal(reflection.due(since + 7 * 3600e3), true, 'new note, 7 hours later')
  assert.equal(reflection.due(since + 60e3), false, 'new note but too soon')
})

test('the brief is shared in the context room only when it changed', async () => {
  const posts = []
  const post = async m => { posts.push(m) }
  await reflection.reflectNow({ post, reflect: async o => memory.reflect({ ...o, askFn: async () => answer('u', 'Brief one.') }) })
  await reflection.reflectNow({ post, reflect: async o => memory.reflect({ ...o, askFn: async () => answer('u', 'Brief one.') }) })
  await reflection.reflectNow({ post, reflect: async o => memory.reflect({ ...o, askFn: async () => answer('u', 'Brief two.') }) })
  assert.equal(posts.length, 2)
  assert.equal(posts[0].room, 'context')
  assert.match(posts[0].text, /Read this before you start a task\.\n\nBrief one\./)
  assert.match(posts[1].text, /Brief two\./)
})
