// End-to-end check of the GPT-Live engine against the real API, with no phone.
// A fake Twilio media stream carries a synthetic caller (OpenAI text-to-speech),
// and the tools are stand-ins, so nothing touches Claude sessions or porch.
// Costs a few cents. Run: npm run check-live
//
// Checks: Anton greets; a status question reaches the get_status tool and the
// answer is spoken; the caller talking over a long answer makes Anton stop.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readdirSync, readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'

process.env.ANTON_HOME = mkdtempSync(join(tmpdir(), 'anton-live-check-'))
process.env.PORCH_URL = ''
const { config } = await import('../src/config.js')
const { handleLiveCall } = await import('../src/live.js')
if (!config.openaiKey) { console.error('OPENAI_API_KEY is missing.'); process.exit(1) }

const t0 = Date.now()
const now = () => Date.now() - t0
const at = () => (now() / 1000).toFixed(1) + 's'

// Synthetic caller: text-to-speech, 24 kHz PCM down to 8 kHz mu-law.
async function say(text) {
  const r = await fetch('https://api.openai.com/v1/audio/speech', { method: 'POST', headers: { Authorization: `Bearer ${config.openaiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: 'alloy', input: text, response_format: 'pcm' }) })
  if (!r.ok) throw new Error(`text-to-speech answered ${r.status}`)
  const pcm = Buffer.from(await r.arrayBuffer())
  const out = []
  for (let i = 0; i + 1 < pcm.length; i += 6) out.push(toMulaw(pcm.readInt16LE(i)))
  return Buffer.from(out)
}
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

const LONG_REPORT = Array.from({ length: 12 }, (_, i) => `Step ${i + 1}: I opened the login test file, read the failing assertion about the session cookie, traced it to a timing race in the mock clock, changed the wait to use the fake timer's run-all helper, ran the suite three times to be sure, and noted that the nightly job should stay green from here on.`).join(' ')

// Stand-in tools: the real guardrail order, canned results.
const toolCalls = []
const makeTools = ({ onHangup }) => ({
  userSpoke() {}, outside() {}, blocked: () => false,
  run: async (name, args) => {
    toolCalls.push({ at: now(), name, args })
    console.log(at(), `tool ${name} ${JSON.stringify(args)}`)
    if (name === 'end_call') { onHangup(); return { ok: true, note: 'Say a short goodbye now.' } }
    if (name === 'get_status') return { sessions: [{ name: 'main', purpose: 'general tasks', running: false, lastResult: 'Fixed the flaky login test and pushed it.', fullReport: LONG_REPORT }] }
    return { ok: true, note: 'Done.' }
  },
})

// Fake Twilio: a 20 ms clock streams caller audio (or silence) in, and records
// each 20 ms of Anton's audio as speech or silence.
const twilio = new EventEmitter()
twilio.readyState = 1
twilio.close = () => {}
const outFrames = [] // { at, loud }
let outBuf = Buffer.alloc(0)
twilio.send = raw => {
  const m = JSON.parse(raw)
  if (m.event !== 'media') return
  outBuf = Buffer.concat([outBuf, Buffer.from(m.media.payload, 'base64')])
  while (outBuf.length >= 160) { outFrames.push({ at: now(), loud: loud(outBuf.subarray(0, 160)) }); outBuf = outBuf.subarray(160) }
}
handleLiveCall(twilio, { makeTools, summarize: async () => {} })
const silence = Buffer.alloc(160, 0xff).toString('base64')
let talking = []
let ts = 0
const clock = setInterval(() => {
  ts += 20
  twilio.emit('message', JSON.stringify({ event: 'media', media: { timestamp: String(ts), payload: talking.shift() || silence } }))
}, 20)
const speak = buf => { talking = []; for (let i = 0; i < buf.length; i += 160) talking.push(buf.subarray(i, i + 160).toString('base64')) }
const wait = ms => new Promise(r => setTimeout(r, ms))
const spokeSince = (t, ms = 600) => outFrames.filter(f => f.at > t && f.loud).length * 20 >= ms
const quietFor = (t, ms) => { const after = outFrames.filter(f => f.at > t); for (let i = 0, run = 0; i < after.length; i++) { run = after[i].loud ? 0 : run + 20; if (run >= ms) return after[i].at - ms - t } return null }
async function until(cond, ms) { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await wait(100) } return false }

const [askStatus, askLong, cutIn] = await Promise.all([
  say('Hi Anton. What is my main session doing right now?'),
  say('Thanks. Read me the full report from that session, word for word, all of it.'),
  say('Stop, stop. That is enough, thanks.'),
])
twilio.emit('message', JSON.stringify({ event: 'start', start: { streamSid: 'MZcheck', callSid: 'CAlivecheck' } }))
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(at(), `${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`) }

check('greets the caller', await until(() => spokeSince(0, 800), 10000))
await until(() => quietFor(0, 1200) !== null && spokeSince(0, 800), 10000)

let mark = now()
speak(askStatus)
const usedTool = await until(() => toolCalls.some(c => c.name === 'get_status'), 20000)
check('status question reaches get_status', usedTool)
const answered = await until(() => spokeSince(toolCalls.find(c => c.name === 'get_status')?.at ?? mark, 1500), 15000)
check('the answer is spoken', answered)
await until(() => quietFor(now() - 100, 1500) !== null, 20000)

speak(askLong)
mark = now() + askLong.length / 8
await until(() => spokeSince(mark, 4000), 25000)
const cutAt = now()
speak(cutIn)
await wait(cutIn.length / 8 + 4000)
const stopMs = quietFor(cutAt, 700)
check('stops talking when the caller cuts in', stopMs !== null && stopMs < 2500, stopMs === null ? 'kept talking' : `quiet ${(stopMs / 1000).toFixed(1)}s after the caller started`)

clearInterval(clock)
twilio.emit('message', JSON.stringify({ event: 'stop' }))
await wait(2500)
console.log('\nCall transcript:')
const calls = join(process.env.ANTON_HOME, 'memory', 'calls')
for (const f of readdirSync(calls)) {
  for (const l of readFileSync(join(calls, f), 'utf8').trim().split('\n')) {
    const x = JSON.parse(l)
    console.log(`  ${x.who}: ${x.text.slice(0, 160)}`)
  }
}
const failed = results.filter(r => !r.ok).length
console.log(`\n${results.length - failed} of ${results.length} checks passed`)
process.exit(failed ? 1 : 0)
