// Turns Anton's real call transcripts into benchmark scenarios, on this laptop only.
//
//   node scripts/bench/make.js [--max 10]
//
// For each call with enough of the caller's turns, a model drafts what the caller
// asked for and which words are private; the caller's lines are sanitized; and a
// snapshot of sessions and agents is saved for the stand-in tools. Scenarios go to
// ANTON_HOME/bench/scenarios. Read each one before trusting it.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { config } from '../../src/config.js'
import * as agent from '../../src/agent.js'
import { sanitize } from './sanitize.js'

const max = Number(process.argv[process.argv.indexOf('--max') + 1]) || 10
const callsDir = join(config.antonHome, 'memory', 'calls')
const outDir = join(config.antonHome, 'bench', 'scenarios')
mkdirSync(outDir, { recursive: true })

const readCall = f => readFileSync(join(callsDir, f), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)

async function ask(prompt) {
  let out = ''
  for await (const msg of query({ prompt, options: { tools: [], maxTurns: 1, settingSources: [], persistSession: false, model: config.memoryModel, env: { ...process.env, ANTON_CHILD: '1' } } })) {
    if (msg.type === 'result' && msg.subtype === 'success') out = msg.result || ''
  }
  return out
}

// Complaints and hand-offs make a call worth testing first.
const weight = lines => {
  const user = lines.filter(l => l.who === 'user').map(l => l.text.toLowerCase()).join(' ')
  const tools = lines.filter(l => l.who === 'tool').length
  return (/(missing|not respond|ignor|repeat|again|can you hear)/.test(user) ? 10 : 0) + tools + lines.filter(l => l.who === 'user').length / 4
}

const calls = readdirSync(callsDir).filter(f => f.endsWith('.jsonl'))
  .map(f => ({ f, lines: readCall(f) }))
  .filter(c => c.lines.filter(l => l.who === 'user').length >= 4)
  .sort((a, b) => weight(b.lines) - weight(a.lines))
  .slice(0, max)

// What the stand-in tools answer with: the current sessions and agents, trimmed.
const snapshot = {
  sessions: agent.list().map(s => ({ name: s.name, purpose: s.purpose, state: s.running ? 'working' : 'idle', lastResult: String(s.lastResult || '').slice(0, 240) })),
}

for (const [i, { f, lines }] of calls.entries()) {
  const id = `${f.slice(0, 10)}_${String(i + 1).padStart(2, '0')}`
  const file = join(outDir, `${id}.json`)
  if (existsSync(file)) { console.log(`${id}: exists, skipped`); continue }
  const talk = lines.filter(l => l.who !== 'update').map(l => `${l.who}: ${l.text}`).join('\n').slice(0, 16000)
  const raw = await ask(`Here is a phone call between ${config.userName} and their assistant ${config.assistantName}. Lines marked "tool" are actions the assistant took.

Reply with only JSON, no prose:
{
  "title": "a few words on what the call was about",
  "requests": [ { "id": "r1", "say": "what ${config.userName} asked for, in a few words", "tool": "the assistant action that would satisfy it: ask_agent, ask_claude, call_me_back, start_long_run, stop_long_run, answer_permission, remember, forget, create_session, hub_post, or none if it only needed an answer", "target": "the agent or session name it is for, or empty" } ],
  "privateTerms": [ "names of other people, companies tied to customers, places, or anything personal that should be masked; never ${config.userName}" ]
}
Count only real requests to do or send something, not questions that only needed an answer. Include requests that were never acted on.

Call:
${talk}`)
  let draft
  try { draft = JSON.parse(String(raw).replace(/^```(json)?|```$/g, '').trim()) } catch { console.log(`${id}: model gave no JSON, skipped`); continue }
  const terms = draft.privateTerms || []
  const clean = t => sanitize(t, { terms, keep: [config.userName, config.assistantName] })
  const t0 = Date.parse(lines[0].ts)
  const turns = []
  let lastAnton = -Infinity
  for (const l of lines) {
    const at = Date.parse(l.ts) - t0
    if (l.who === 'anton') lastAnton = at
    if (l.who !== 'user') continue
    // The transcript stamps a line when it ends; a line right after Anton spoke was
    // probably said over Anton.
    turns.push({ text: clean(l.text), at, overAnton: at - lastAnton < 1200 })
  }
  const scenario = {
    id, source: f, title: clean(draft.title || ''),
    turns,
    updatesAtStart: lines.filter(l => l.who === 'update' && Date.parse(l.ts) - t0 < 5000).map(l => clean(l.text).slice(0, 600)),
    expect: { requests: (draft.requests || []).filter(r => r.tool && r.tool !== 'none').map(r => ({ ...r, say: clean(r.say) })) },
    snapshot,
    made: new Date().toISOString(),
  }
  writeFileSync(file, JSON.stringify(scenario, null, 1))
  console.log(`${id}: ${scenario.turns.length} turns, ${scenario.expect.requests.length} requests: ${scenario.title}`)
}
console.log(`\nScenarios are in ${outDir}. Read them before the first run.`)
process.exit(0)
