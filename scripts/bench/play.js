// Plays one benchmark scenario as a fake phone call on the real GPT-Live API and
// writes what happened to a JSON file. Run by run.js; can be run alone:
//   node scripts/bench/play.js <scenario.json> <out.json> [seed]
// Stand-in tools answer from the scenario's snapshot, and agent replies come back
// as updates after a delay, so no real session, agent or porch post is touched.
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'

const [scenarioFile, outFile, seedArg] = process.argv.slice(2)
const benchHome = process.env.BENCH_HOME
process.env.ANTON_HOME = mkdtempSync(join(tmpdir(), 'anton-bench-'))
process.env.PORCH_URL = ''
const { config } = await import('../../src/config.js')
const caller = await import('../../src/caller.js')
const { handleLiveCall } = await import('../../src/live.js')
caller.setDialer(() => {})

const scenario = JSON.parse(readFileSync(scenarioFile, 'utf8'))
let seed = Number(seedArg) || 1
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
const t0 = Date.now()
const now = () => Date.now() - t0
const wait = ms => new Promise(r => setTimeout(r, ms))

// Caller voice: text-to-speech, cached on disk, 24 kHz PCM down to 8 kHz mu-law.
function toMulaw(s) {
  let sign = (s >> 8) & 0x80
  if (sign) s = -s
  if (s > 32635) s = 32635
  s += 0x84
  let exp = 7
  for (let mask = 0x4000; (s & mask) === 0 && exp > 0; exp--, mask >>= 1);
  return ~(sign | (exp << 4) | ((s >> (exp + 3)) & 0x0f)) & 0xff
}
function fromMulaw(u) {
  u = ~u & 0xff
  const t = (((u & 0x0f) << 3) + 0x84) << ((u & 0x70) >> 4)
  return u & 0x80 ? 0x84 - t : t - 0x84
}
const loud = buf => { let e = 0; for (const b of buf) e += Math.abs(fromMulaw(b)); return e / buf.length > 300 }
async function say(text) {
  const dir = join(benchHome, 'tts')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, createHash('sha256').update(text).digest('hex').slice(0, 16) + '.ulaw')
  if (existsSync(file)) return readFileSync(file)
  const r = await fetch('https://api.openai.com/v1/audio/speech', { method: 'POST', headers: { Authorization: `Bearer ${config.openaiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: 'alloy', input: text, response_format: 'pcm' }) })
  if (!r.ok) throw new Error(`text-to-speech answered ${r.status}`)
  const pcm = Buffer.from(await r.arrayBuffer())
  const out = []
  for (let i = 0; i + 1 < pcm.length; i += 6) out.push(toMulaw(pcm.readInt16LE(i)))
  writeFileSync(file, Buffer.from(out))
  return Buffer.from(out)
}

// Stand-in tools: the real guardrail, answers from the snapshot, quick like the
// real local tools (the slow part on real calls is the backend model, which is real here).
const tools = []
const snap = scenario.snapshot || {}
const answers = {
  get_status: args => args.session ? (snap.sessions || []).find(s => s.name === args.session) || { ok: false, reason: `No session named ${args.session}.` } : { sessions: snap.sessions || [] },
  list_agents: () => ({ agents: [...(snap.sessions || []).map(s => ({ name: s.name, kind: 'claude-code session' })), { name: 'muse', kind: 'agent on porch' }, { name: 'grokbot', kind: 'agent on porch' }, { name: 'claude-ai', kind: 'agent on porch' }, { name: 'renfort', kind: 'live Claude Code session through porch' }] }),
  agent_work: args => ({ agent: args.agent, posts: [{ when: 'today', text: `Latest work from ${args.agent}: a short summary of its most recent findings.` }] }),
  hub_read: () => [{ from: 'muse', room: 'research', text: 'Research dashboard: world models with 3D memory; open robot datasets; funding for physical AI.' }],
  recall: () => ({ found: [] }),
}
const makeTools = ({ onHangup }) => {
  let user = 0, outside = 0, clock = 0
  return {
    userSpoke() { user = ++clock }, outside() { outside = ++clock }, blocked: () => outside > user,
    run: async (name, args) => {
      tools.push({ at: now(), name, args })
      await wait(200 + rand() * 600)
      if (name === 'end_call') { onHangup(); return { ok: true, note: 'Say a short goodbye now.' } }
      if (answers[name]) return answers[name](args)
      if (name === 'ask_agent' || name === 'ask_claude') {
        const who = args.agent || args.session || 'main'
        setTimeout(() => caller.notify({ kind: 'done', session: who, text: `${who} replied: done, with a short answer to "${String(args.message || '').slice(0, 80)}".` }), 20000 + rand() * 20000)
        return { ok: true, session: who, note: `Sent to ${who}. Its reply comes back as an update.` }
      }
      return { ok: true }
    },
  }
}

// Fake Twilio: a 20 ms clock carries the caller in and records Anton out.
const twilio = new EventEmitter()
twilio.readyState = 1
twilio.close = () => {}
const speech = []
let outBuf = Buffer.alloc(0)
twilio.send = raw => {
  const m = JSON.parse(raw)
  if (m.event !== 'media') return
  outBuf = Buffer.concat([outBuf, Buffer.from(m.media.payload, 'base64')])
  while (outBuf.length >= 160) { speech.push({ at: now(), loud: loud(outBuf.subarray(0, 160)) }); outBuf = outBuf.subarray(160) }
}
for (const u of scenario.updatesAtStart || []) caller.notify({ kind: 'note', ring: false, session: 'bench', text: u })
const lines = []
handleLiveCall(twilio, { makeTools, summarize: async (_, l) => { lines.push(...l) } })
const silence = Buffer.alloc(160, 0xff).toString('base64')
let talking = []
let ts = 0
const tick = setInterval(() => { ts += 20; twilio.emit('message', JSON.stringify({ event: 'media', media: { timestamp: String(ts), payload: talking.shift() || silence } })) }, 20)
const quietFor = ms => { const tail = speech.slice(-Math.ceil(ms / 20)); return tail.length >= ms / 20 && tail.every(f => !f.loud) }
async function until(cond, ms) { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await wait(100) } return false }

twilio.emit('message', JSON.stringify({ event: 'start', start: { streamSid: 'MZbench', callSid: `CAbench${seed}` } }))
const userAudio = []
const audio = await Promise.all(scenario.turns.map(t => say(t.text)))
const spokeSince = at => speech.some(f => f.loud && f.at > at)
const toolSince = at => tools.some(c => c.at > at)
// After a line, a person waits for an answer: until Anton starts speaking (longer
// while a tool is running, since the backend is slow), then until it has finished.
async function awaitAnswer(after) {
  await until(() => spokeSince(after) || (!toolSince(after) && now() - after > 15000) || now() - after > 45000, 46000)
  if (spokeSince(after)) await until(() => quietFor(1500), 60000)
}
let prevAt = 0
let prevEnd = 0
for (const [i, t] of scenario.turns.entries()) {
  if (i > 0) {
    // A line said over Anton is played at its original spacing, answer or not.
    if (t.overAnton) await wait(Math.min(4000, Math.max(300, t.at - prevAt - 2000)))
    else await awaitAnswer(prevEnd)
  }
  prevAt = t.at
  const start = now()
  talking = []
  for (let k = 0; k < audio[i].length; k += 160) talking.push(audio[i].subarray(k, k + 160).toString('base64'))
  await until(() => !talking.length, 60000)
  prevEnd = now()
  userAudio.push({ start, end: prevEnd, text: t.text, overAnton: !!t.overAnton })
}
await awaitAnswer(prevEnd)
await until(() => quietFor(4000), 40000)
clearInterval(tick)
twilio.emit('message', JSON.stringify({ event: 'stop' }))
await wait(2500)

// Turn times: the transcript stamps each line when it is complete.
const turns = lines.filter(l => l.who === 'user' || l.who === 'anton').map(l => ({ who: l.who, text: l.text, start: Date.parse(l.ts) - t0 - 2000, end: Date.parse(l.ts) - t0 }))
writeFileSync(outFile, JSON.stringify({ scenario: scenario.id, seed, seconds: Math.round(now() / 1000), turns, tools, speech, userAudio }))
process.exit(0)
