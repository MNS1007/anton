// Runs the call benchmark and decides whether the current call code may ship.
//
//   npm run bench-calls                    compare against the baseline
//   npm run bench-calls -- --baseline      record a new baseline
//   options: --runs 3  --only <id,id>  --parallel 3  --post (send the result table to porch)
//
// Scenarios come from ANTON_HOME/bench/scenarios (make them with make.js). Each one
// is played --runs times, a few at a time; scores and the gate verdict are saved
// to ANTON_HOME/bench/results.
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { config } from '../../src/config.js'
import { score } from './metrics.js'
import { summarize, gate, table } from './gate.js'

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt }
const flag = name => process.argv.includes(`--${name}`)
const runs = Number(arg('runs', 3))
const parallel = Number(arg('parallel', 3))
const only = arg('only', '') ? arg('only').split(',') : null

const home = join(config.antonHome, 'bench')
const scenDir = join(home, 'scenarios')
const resDir = join(home, 'results')
mkdirSync(resDir, { recursive: true })
const scenarios = readdirSync(scenDir).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(scenDir, f), 'utf8'))).filter(s => !only || only.includes(s.id))
if (!scenarios.length) { console.error(`No scenarios in ${scenDir}. Run scripts/bench/make.js first.`); process.exit(1) }

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const runDir = join(resDir, stamp)
mkdirSync(runDir, { recursive: true })
const play = fileURLToPath(new URL('./play.js', import.meta.url))
const jobs = scenarios.flatMap(s => Array.from({ length: runs }, (_, k) => ({ s, k })))
console.log(`${scenarios.length} scenarios x ${runs} runs, ${parallel} at a time`)

// A model reads the played call and says, per expected request, whether Anton did
// it (any valid way), asked about it and followed up, or dropped it.
async function judge(s, rec) {
  const reqs = s.expect?.requests || []
  if (!reqs.length) return []
  const call = rec.turns.map(t => `${t.who}: ${t.text}`).join('\n').slice(0, 12000)
  const actions = rec.tools.map(t => `${t.name} ${JSON.stringify(t.args).slice(0, 300)}`).join('\n') || '(none)'
  let out = ''
  try {
    for await (const msg of query({ prompt: `You grade a phone assistant. For each request the caller made, decide the outcome:
- "done": the assistant took an action that carries out the request, even if through a different tool or wording than listed
- "asked": it could not act yet and asked the caller about this request, and did not leave it hanging (it either got an answer and acted, or said clearly what it still needs)
- "dropped": it neither acted nor asked, or asked and then forgot it

Requests:
${reqs.map(r => `${r.id}: ${r.say}`).join('\n')}

Assistant actions:
${actions}

Call:
${call}

Reply with only JSON: [{"id": "r1", "outcome": "done|asked|dropped"}]`, options: { tools: [], maxTurns: 1, settingSources: [], persistSession: false, model: config.memoryModel, env: { ...process.env, ANTON_CHILD: '1' } } })) {
      if (msg.type === 'result' && msg.subtype === 'success') out = msg.result || ''
    }
    const list = JSON.parse(String(out).replace(/^```(json)?|```$/g, '').trim())
    return reqs.map(r => ({ id: r.id, outcome: list.find(x => x.id === r.id)?.outcome || 'dropped' }))
  } catch { return null }
}

async function one({ s, k }) {
  const out = join(runDir, `${s.id}_${k + 1}.json`)
  await new Promise(resolve => {
    const p = spawn(process.execPath, [play, join(scenDir, `${s.id}.json`), out, String(k + 1)], { env: { ...process.env, BENCH_HOME: home }, stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    p.stderr.on('data', d => { err += d })
    p.on('exit', code => { if (code) console.log(`  ${s.id} run ${k + 1} failed: ${err.slice(-300)}`); resolve() })
  })
  if (!existsSync(out)) return null
  const rec = JSON.parse(readFileSync(out, 'utf8'))
  const sc = score(rec, s, await judge(s, rec))
  console.log(`  ${s.id} run ${k + 1}: dropped ${sc.dropped}/${sc.requests}, unanswered ${sc.unanswered}, repeats ${sc.repeats}, delay ${sc.delayMedianMs ?? '-'} ms, ${rec.seconds}s`)
  return { id: s.id, run: k + 1, ...sc }
}

const results = []
const queue = [...jobs]
await Promise.all(Array.from({ length: Math.min(parallel, queue.length) }, async () => { while (queue.length) { const r = await one(queue.shift()); if (r) results.push(r) } }))

const byScenario = {}
for (const r of results) (byScenario[r.id] ||= []).push(r)
const current = summarize(byScenario)
const baseFile = join(resDir, 'baseline.json')
writeFileSync(join(runDir, 'scores.json'), JSON.stringify({ results, current }, null, 1))

if (flag('baseline')) {
  writeFileSync(baseFile, JSON.stringify(current, null, 1))
  console.log(`\nBaseline saved (${results.length} runs).`)
} else {
  const baseline = existsSync(baseFile) ? JSON.parse(readFileSync(baseFile, 'utf8')) : null
  const verdict = gate(current, baseline)
  writeFileSync(join(runDir, 'gate.json'), JSON.stringify(verdict, null, 1))
  console.log(`\n${verdict.ship ? 'SHIP' : 'DO NOT SHIP'}: ${verdict.reason}\n${table(verdict.rows)}`)
}

// Totals for a human, and for porch.
const t = current
const line = `Call bench (${scenarios.length} scenarios x ${runs} runs): ${t.dropped.total.toFixed(1)} dropped requests, ${t.unanswered.total.toFixed(1)} lines never answered, ${t.repeats.total.toFixed(1)} repeats, ${t.fillers.total.toFixed(1)} empty "checking", ${t.talkOvers.total.toFixed(1)} talk-overs, ${t.wrongActions.total.toFixed(1)} wrong actions per pass.`
console.log(`\n${line}\nResults: ${runDir}`)
writeFileSync(join(runDir, 'summary.txt'), line + '\n')
process.exit(0)
