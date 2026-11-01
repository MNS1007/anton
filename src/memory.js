// Anton's memory, as plain files in ANTON_HOME/memory:
//   profile.md       what Anton should always know about you (you can edit it)
//   notes.jsonl      things you asked it to remember, and facts it learned from calls
//   episodes.jsonl   a short summary of each call
//   tasks.jsonl      every Claude task and how it ended
//   calls/           full call transcripts
//   forgotten.jsonl  what you asked it to forget, so it is not learned again
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { config } from './config.js'
import { log } from './log.js'

const dir = join(config.antonHome, 'memory')
const file = name => join(dir, name)
const PROFILE_TEMPLATE = `# About me

Write anything ${config.assistantName} should always know: your work, the people you mention, how you like updates.
${config.assistantName} reads this file at the start of every call and every Claude task.
`

mkdirSync(join(dir, 'calls'), { recursive: true })
if (!existsSync(file('profile.md'))) writeFileSync(file('profile.md'), PROFILE_TEMPLATE)

function readLines(name) {
  try {
    return readFileSync(file(name), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch { return [] }
}
const append = (name, obj) => appendFileSync(file(name), JSON.stringify(obj) + '\n')
const now = () => new Date().toISOString()

// Word overlap is enough for a personal memory of a few hundred lines.
const words = s => new Set(String(s).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [])
function score(queryText, text) {
  const q = words(queryText)
  if (!q.size) return 0
  const t = words(text)
  let hit = 0
  for (const w of q) if (t.has(w) || [...t].some(x => x.startsWith(w) || w.startsWith(x))) hit++
  return hit / q.size
}

// Notes

export function remember(text, source = 'you') {
  text = String(text || '').trim().slice(0, 500)
  if (!text) return { ok: false, reason: 'Nothing to remember.' }
  const notes = readLines('notes.jsonl')
  if (notes.some(n => n.text.toLowerCase() === text.toLowerCase())) return { ok: true, note: 'Already remembered.' }
  append('notes.jsonl', { id: randomBytes(4).toString('hex'), ts: now(), source, text })
  log(`remembered (${source}): ${text.slice(0, 80)}`)
  return { ok: true }
}

export function forget(description) {
  const notes = readLines('notes.jsonl')
  const scored = notes.map(n => ({ n, s: score(description, n.text) }))
  const best = Math.max(0, ...scored.map(x => x.s))
  if (best < 0.34) return { ok: false, reason: 'Nothing I remember matches that.' }
  // Everything close to the best match goes, so "forget my old address" removes every version of it.
  const gone = scored.filter(x => x.s >= Math.max(0.34, best - 0.15)).map(x => x.n)
  const keep = notes.filter(n => !gone.includes(n))
  writeFileSync(file('notes.jsonl'), keep.map(n => JSON.stringify(n)).join('\n') + (keep.length ? '\n' : ''))
  append('forgotten.jsonl', { ts: now(), description, removed: gone.map(n => n.text) })
  log(`forgot ${gone.length} note(s)`)
  return { ok: true, forgot: gone.map(n => n.text), note: 'Call transcripts are kept. Delete them from the calls folder if needed.' }
}

function wasForgotten(text) {
  return readLines('forgotten.jsonl').some(f => score(f.description, text) >= 0.6 || f.removed?.some(r => score(r, text) >= 0.8))
}

export function recall(queryText, limit = 6) {
  const items = [
    ...readLines('notes.jsonl').map(n => ({ kind: 'note', when: n.ts, text: n.text })),
    ...readLines('episodes.jsonl').map(e => ({ kind: 'call', when: e.ts, text: e.summary })),
    ...readLines('tasks.jsonl').map(t => ({ kind: 'task', when: t.ts, text: `[${t.session}] ${t.task}: ${t.failed ? `ended early: ${t.failed}` : t.result}` })),
  ]
  return items
    .map(i => ({ ...i, s: score(queryText, i.text) }))
    .filter(i => i.s >= 0.34)
    .sort((a, b) => b.s - a.s || b.when.localeCompare(a.when))
    .slice(0, limit)
    .map(({ s, ...i }) => ({ ...i, text: clip(i.text, 400) }))
}

// What gets put in front of the voice model and Claude. Kept to about 3k tokens.
export function context({ calls = true } = {}) {
  const parts = []
  const profile = readFileSync(file('profile.md'), 'utf8').trim()
  if (profile && profile !== PROFILE_TEMPLATE.trim()) parts.push(`Profile:\n${clip(profile, 3000)}`)
  const notes = readLines('notes.jsonl').slice(-40)
  if (notes.length) parts.push(`Notes:\n${clip(notes.map(n => `- ${n.text}`).join('\n'), 3500)}`)
  if (calls) {
    const eps = readLines('episodes.jsonl').slice(-5)
    if (eps.length) parts.push(`Recent calls:\n${clip(eps.map(e => `- ${e.ts.slice(0, 10)}: ${e.summary}`).join('\n'), 2000)}`)
    const tasks = readLines('tasks.jsonl').slice(-5)
    if (tasks.length) parts.push(`Recent Claude tasks:\n${clip(tasks.map(t => `- ${t.ts.slice(0, 10)} [${t.session}] ${clip(t.task, 120)}: ${t.failed ? 'ended early' : 'done'}`).join('\n'), 1500)}`)
  }
  return parts.join('\n\n')
}

export function logTask({ session, task, result, failed, source }) {
  append('tasks.jsonl', { ts: now(), session, source, task: clip(task, 300), result: clip(result, 1500), failed: failed ? clip(failed, 300) : null })
}

// Calls

export function transcript(callSid) {
  const name = `${now().slice(0, 10)}_${callSid || randomBytes(4).toString('hex')}.jsonl`
  const lines = []
  return {
    add(who, text) {
      text = String(text || '').trim()
      if (!text) return
      const line = { ts: now(), who, text }
      lines.push(line)
      try { appendFileSync(join(dir, 'calls', name), JSON.stringify(line) + '\n') } catch {}
    },
    lines: () => lines,
  }
}

// After a call: a short summary of the whole call, and durable facts taken only
// from what the user said. Agent posts that Anton read aloud never become facts.
export async function summarizeCall(callSid, lines) {
  const userLines = lines.filter(l => l.who === 'user')
  if (userLines.length < 2) return
  const talk = lines.filter(l => l.who !== 'tool').map(l => `${l.who}: ${l.text}`).join('\n')
  const [summary, facts] = await Promise.all([
    ask(`Summarize this phone call between ${config.userName} and their assistant ${config.assistantName} in one to three plain sentences: what ${config.userName} wanted, what was done or decided, and anything left open. Use ${config.userName}'s name or they, never guessed pronouns. Reply with only the summary.\n\n${clip(talk, 20000)}`),
    ask(`These are things ${config.userName} said on a phone call. List durable facts about ${config.userName} worth remembering for future calls: preferences, plans, people, projects, deadlines. Skip anything about this call only, small talk, or instructions for a single task. Write each fact as a short sentence that starts with ${config.userName}'s name. Never guess pronouns: repeat the name or use they. Reply with only a JSON array of strings, or [] if there is nothing.\n\n${clip(userLines.map(l => l.text).join('\n'), 12000)}`),
  ])
  if (summary) append('episodes.jsonl', { ts: now(), callSid, summary: clip(summary.trim(), 800) })
  let list = []
  try { list = JSON.parse(String(facts).replace(/^```(json)?|```$/g, '').trim()) } catch {}
  for (const f of Array.isArray(list) ? list.slice(0, 8) : []) {
    if (typeof f === 'string' && f.trim() && !wasForgotten(f)) remember(f, 'call')
  }
  log(`call remembered: ${summary ? 'summary' : 'no summary'}, ${Array.isArray(list) ? list.length : 0} fact(s)`)
}

// A one-shot Claude answer with no tools, for summaries.
async function ask(prompt) {
  let out = ''
  try {
    for await (const msg of query({
      prompt,
      options: { tools: [], maxTurns: 1, settingSources: [], persistSession: false, model: config.memoryModel, cwd: dir },
    })) {
      if (msg.type === 'result' && msg.subtype === 'success') out = msg.result || ''
    }
  } catch (err) {
    log(`memory summary failed: ${err.message}`)
  }
  return out
}

function clip(s, n) {
  s = String(s || '')
  return s.length > n ? s.slice(0, n) + '...' : s
}
