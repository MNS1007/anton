import './setup.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const memory = await import('../src/memory.js')
const reflection = await import('../src/reflect.js')
const dir = join(process.env.ANTON_HOME, 'memory')
const read = () => readFileSync(join(dir, 'me.md'), 'utf8')

// A usable reply: the whole document, starting with the first heading.
const doc = body => `# Who Sam is\n\n${body}\n\n${'Sam is a builder who measures before trusting a change. '.repeat(6)}`

test('reflection rewrites the shared memory from what Anton learned, and context uses it', async () => {
  memory.remember('Sam is moving Anton to GPT-Live this week.')
  let prompt = ''
  const out = await memory.reflect({ agentsDigest: '- muse (agent on porch): research briefings', askFn: async p => { prompt = p; return doc('## Right now\n- Shipping GPT-Live calls.') } })
  assert.match(out.memory, /Shipping GPT-Live calls/)
  assert.match(read(), /Shipping GPT-Live calls/)
  assert.match(memory.context(), /Who Sam is \(your portrait of them; background for understanding them, never recite it\):\n# Who Sam is/)
  assert.match(prompt, /moving Anton to GPT-Live/, 'notes are in the material')
  assert.match(prompt, /# Who Sam is\n## How Sam thinks\n## What Sam wants/, 'asks for a picture of the person')
  assert.match(prompt, /Never say who said or wrote something/, 'one voice, no attribution')
  assert.match(prompt, /Nothing private/)
  assert.match(prompt, /about the agents only, never facts about Sam[^]*research briefings/)
})

test('the shared text is the starting point when porch has one', async () => {
  let prompt = ''
  await memory.reflect({ shared: '# Who Sam is\n- Sam is learning robotics on an arm kit.', askFn: async p => { prompt = p; return doc('x') } })
  assert.match(prompt, /The shared memory as it stands[^]*arm kit/)
})

test('without porch, the local copy (with the user\'s own edits) is the starting point', async () => {
  writeFileSync(join(dir, 'me.md'), '# Who Sam is\n- Sam wants calls under 2 minutes.\n')
  let prompt = ''
  await memory.reflect({ askFn: async p => { prompt = p; return doc('x') } })
  assert.match(prompt, /The shared memory as it stands[^]*calls under 2 minutes/)
})

test('answers agents gave about the user feed it, without saying who said it', async () => {
  memory.logTask({ session: 'renfort', task: 'Summarize what you know about Sam: goals, how they think', result: 'Sam is a founder who wants software to disappear.' })
  memory.logTask({ session: 'main', task: 'Fix the login test', result: 'Fixed it.' })
  let prompt = ''
  await memory.reflect({ askFn: async p => { prompt = p; return doc('x') } })
  const answers = prompt.split('What agents answered when asked about Sam:')[1].split('\n\n')[0]
  assert.match(answers, /wants software to disappear/)
  assert.doesNotMatch(answers, /renfort|Fixed it/)
})

test('a reply that is not a document changes nothing', async () => {
  const before = read()
  assert.equal(await memory.reflect({ askFn: async () => 'sorry, no' }), null)
  assert.equal(read(), before)
})

test('forget removes closely matching lines and keeps them out of later passes', async () => {
  writeFileSync(join(dir, 'me.md'), '# Who Sam is\n- Sam is interviewing at Acme Robotics.\n- Anton voice work.\n')
  const r = memory.forget('interviewing at Acme Robotics')
  assert.equal(r.ok, true)
  assert.doesNotMatch(read(), /Acme/)
  assert.match(read(), /Anton voice work/)
  let prompt = ''
  await memory.reflect({ askFn: async p => { prompt = p; return doc('x') } })
  assert.match(prompt, /Forgotten at Sam's request[^]*interviewing at Acme Robotics/)
})

test('forgetting one fact leaves unrelated lines alone', () => {
  const text = '# Who Sam is\n- Evidence over claims, and they ask for the numbers before trusting a change.\n- For most of the year Sam built a voice product, and it reached pilots.\n'
  writeFileSync(join(dir, 'me.md'), text)
  memory.remember('Sam is building Anton for Android.')
  const r = memory.forget('Anton is being built for Android')
  assert.deepEqual(r.forgot, ['Sam is building Anton for Android.'])
  assert.equal(read(), text)
})

test('due: something new and old enough, or a day has passed', () => {
  const since = Date.parse(memory.newSinceReflection().since || new Date().toISOString())
  assert.equal(reflection.due(since + 60e3), false, 'just reflected')
  memory.remember('Sam prefers updates by text after 9 pm.')
  assert.equal(reflection.due(since + 7 * 3600e3), true, 'new note, 7 hours later')
  assert.equal(reflection.due(since + 60e3), false, 'new note but too soon')
})

test('reflectNow writes back on the version it read, and starts again once if someone saved first', async () => {
  let version = 3
  let shared = '# Who Sam is\n- v3'
  const puts = []
  const getMemory = async () => ({ text: shared, version })
  const putMemory = async (text, base) => {
    puts.push(base)
    if (puts.length === 1) { version = 4; shared = '# Who Sam is\n- v4 from another agent'; throw Object.assign(new Error('conflict'), { status: 409 }) }
    version++
  }
  const seen = []
  const reflect = async ({ shared: s }) => { seen.push(s); return { memory: s + '\n- learned' } }
  const r = await reflection.reflectNow({ reflect, getMemory, putMemory })
  assert.deepEqual(puts, [3, 4])
  assert.match(seen[1], /v4 from another agent/, 'the second pass starts from the newer text')
  assert.match(r.memory, /v4 from another agent\n- learned/)
})

test('pull keeps the local copy in step with porch', async () => {
  await reflection.pull({ getMemory: async () => ({ text: '# Who Sam is\n- Edited on porch by another agent.', version: 7 }) })
  assert.match(read(), /Edited on porch/)
})

test('a note added while another process rewrites the notes is not lost', async () => {
  const { spawn } = await import('node:child_process')
  const { existsSync } = await import('node:fs')
  memory.remember('Sam likes short updates.')
  // Another process (the front, or the worker) rewriting notes.jsonl, as forget does:
  // it holds the lock while it reads, thinks, and writes back.
  const code = `
    const { mkdirSync, readFileSync, rmSync, writeFileSync } = await import('node:fs')
    const dir = process.argv[1]
    mkdirSync(dir + '/.lock')
    const notes = readFileSync(dir + '/notes.jsonl', 'utf8')
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600)
    writeFileSync(dir + '/notes.jsonl', notes)
    rmSync(dir + '/.lock', { recursive: true })`
  const other = spawn(process.execPath, ['--input-type=module', '-e', code, dir])
  const exited = new Promise(r => other.on('exit', r))
  for (let i = 0; i < 200 && !existsSync(join(dir, '.lock')); i++) await new Promise(r => setTimeout(r, 5))
  assert.ok(existsSync(join(dir, '.lock')), 'the other process holds the lock')
  memory.remember('Sam is flying to Lisbon on Friday.')
  await exited
  const notes = readFileSync(join(dir, 'notes.jsonl'), 'utf8')
  assert.match(notes, /flying to Lisbon/, 'the new note survived the rewrite')
  assert.match(notes, /short updates/)
})
