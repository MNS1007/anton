// Anton's memory, as plain files in ANTON_HOME/memory:
//   profile.md       what Anton should always know about you (you can edit it)
//   notes.jsonl      things you asked it to remember, and facts it learned from calls
//   episodes.jsonl   a short summary of each call
//   tasks.jsonl      every Claude task and how it ended
//   calls/           full call transcripts
//   forgotten.jsonl  what you asked it to forget, so it is not learned again
//   understanding.md Anton's own picture of you, rewritten as it learns (you can edit it)
//   reflections.jsonl when it was rewritten, and the brief shared with your agents
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

// loose: also skip notes that say nearly the same thing (used for learned facts).
export function remember(text, source = 'you', { loose = false } = {}) {
  text = String(text || '').trim().slice(0, 500)
  if (!text) return { ok: false, reason: 'Nothing to remember.' }
  const notes = readLines('notes.jsonl')
  if (notes.some(n => n.text.toLowerCase() === text.toLowerCase() || (loose && score(text, n.text) >= 0.6))) return { ok: true, note: 'Already remembered.' }
  append('notes.jsonl', { id: randomBytes(4).toString('hex'), ts: now(), source, text })
  log(`remembered (${source}): ${text.slice(0, 80)}`)
  return { ok: true }
}

export function forget(description) {
  const notes = readLines('notes.jsonl')
  const scored = notes.map(n => ({ n, s: score(description, n.text) }))
  const best = Math.max(0, ...scored.map(x => x.s))
  // Matching lines of Anton's understanding go too, right away; the next
  // reflection is told never to bring them back.
  const lines = readUnderstanding().split('\n')
  const dropLines = lines.filter(l => /\w/.test(l) && !l.trim().startsWith('#') && score(description, l) >= 0.34)
  if (best < 0.34 && !dropLines.length) return { ok: false, reason: 'Nothing I remember matches that.' }
  // Everything close to the best match goes, so "forget my old address" removes every version of it.
  const gone = best < 0.34 ? [] : scored.filter(x => x.s >= Math.max(0.34, best - 0.15)).map(x => x.n)
  const keep = notes.filter(n => !gone.includes(n))
  writeFileSync(file('notes.jsonl'), keep.map(n => JSON.stringify(n)).join('\n') + (keep.length ? '\n' : ''))
  if (dropLines.length) writeFileSync(file('understanding.md'), lines.filter(l => !dropLines.includes(l)).join('\n').trim() + '\n')
  const removed = [...gone.map(n => n.text), ...dropLines.map(l => l.trim())]
  append('forgotten.jsonl', { ts: now(), description, removed })
  log(`forgot ${removed.length} item(s)`)
  return { ok: true, forgot: removed, note: 'Call transcripts are kept. Delete them from the calls folder if needed.' }
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
  const understanding = readUnderstanding()
  if (understanding) parts.push(`${config.assistantName}'s current understanding of ${config.userName}:\n${clip(understanding, 3000)}`)
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
    ask(`These are things ${config.userName} said on a phone call. List durable facts about ${config.userName} worth remembering for future calls: preferences, plans, people, projects, deadlines. Skip anything already in the known list, anything about this call only, small talk, or instructions for a single task. Write each fact as a short sentence that starts with ${config.userName}'s name. Never guess pronouns: repeat the name or use they. Reply with only a JSON array of strings, or [] if there is nothing.\n\nKnown already:\n${clip(readLines('notes.jsonl').map(n => `- ${n.text}`).join('\n'), 4000) || '(nothing)'}\n\nWhat ${config.userName} said:\n${clip(userLines.map(l => l.text).join('\n'), 12000)}`),
  ])
  if (summary) append('episodes.jsonl', { ts: now(), callSid, summary: clip(summary.trim(), 800) })
  let list = []
  try { list = JSON.parse(String(facts).replace(/^```(json)?|```$/g, '').trim()) } catch {}
  for (const f of Array.isArray(list) ? list.slice(0, 8) : []) {
    if (typeof f === 'string' && f.trim() && !wasForgotten(f)) remember(f, 'call', { loose: true })
  }
  log(`call remembered: ${summary ? 'summary' : 'no summary'}, ${Array.isArray(list) ? list.length : 0} fact(s)`)
}

// Reflection: Anton rewrites its own understanding of the user from everything it
// has learned, so it grows as they do. understanding.md is plain text the user can
// read and correct; their edits are kept because each pass starts from the file.
// The same pass writes a short brief the user's other agents can see on porch.

const readUnderstanding = () => { try { return readFileSync(file('understanding.md'), 'utf8').trim() } catch { return '' } }

export const lastReflection = () => readLines('reflections.jsonl').at(-1) || null

// Has anything been learned since the last reflection?
export function newSinceReflection() {
  const last = readLines('reflections.jsonl').at(-1)?.ts || ''
  const fresh = name => readLines(name).filter(x => x.ts > last).length
  return { since: last || null, notes: fresh('notes.jsonl'), calls: fresh('episodes.jsonl'), tasks: fresh('tasks.jsonl') }
}

// agentsDigest: what each agent is for and doing, from porch and Claude sessions.
// Returns { understanding, brief } or null when the model gave nothing usable.
export async function reflect({ agentsDigest = '', askFn = ask } = {}) {
  const u = config.userName
  const profile = readFileSync(file('profile.md'), 'utf8').trim()
  const material = [
    `Profile, written by ${u} (always right; never contradict it):\n${profile === PROFILE_TEMPLATE.trim() ? '(empty)' : clip(profile, 4000)}`,
    `${config.assistantName}'s understanding so far (may include ${u}'s own corrections; keep them):\n${readUnderstanding() || '(none yet)'}`,
    `Notes (things ${u} said or asked to remember), oldest first:\n${clip(readLines('notes.jsonl').slice(-80).map(n => `- ${n.ts.slice(0, 10)} ${n.text}`).join('\n'), 8000) || '(none)'}`,
    `Call summaries:\n${clip(readLines('episodes.jsonl').slice(-20).map(e => `- ${e.ts.slice(0, 10)} ${e.summary}`).join('\n'), 6000) || '(none)'}`,
    `Claude tasks:\n${clip(readLines('tasks.jsonl').slice(-30).map(t => `- ${t.ts.slice(0, 10)} [${t.session}] ${clip(t.task, 160)}: ${t.failed ? 'ended early' : 'done'}`).join('\n'), 5000) || '(none)'}`,
    `Forgotten at ${u}'s request (never write these or anything like them):\n${clip(readLines('forgotten.jsonl').map(f => `- ${f.description}`).join('\n'), 2000) || '(nothing)'}`,
    `What ${u}'s agents are doing (information about the agents only, never facts about ${u}):\n${clip(agentsDigest, 6000) || '(nothing)'}`,
  ].join('\n\n')
  const out = await askFn(`You keep ${config.assistantName}'s memory. ${config.assistantName} is ${u}'s assistant and the single point of contact for all of ${u}'s agents. Today is ${now().slice(0, 10)}.

Rewrite ${config.assistantName}'s understanding of ${u} from the material below, so it stays current as ${u}'s goals and work change. Use these headings: Goals now; Projects and where each stands; How ${u} likes to work and get updates; ${u}'s agents (what each is for and how ${u} uses it); Open threads. Keep what is still true, update what changed, drop what is stale or finished. Only state things the material supports. Facts about ${u} come only from the profile, notes, call summaries and tasks. Use ${u}'s name or they, never guessed pronouns. At most 450 words.

Then write a brief for ${u}'s other agents, so each knows what ${u} is doing with the others: what ${u} is focused on now and what each agent is working on. Nothing private: no health, money, family, other people's personal details, contact details, credentials or anything ${u} said in confidence. At most 150 words.

Reply in exactly this form:
### UNDERSTANDING
...
### BRIEF
...

${material}`)
  const m = /###\s*UNDERSTANDING\s*([\s\S]*?)###\s*BRIEF\s*([\s\S]*)$/i.exec(String(out || ''))
  if (!m || !m[1].trim()) { log('reflection gave nothing usable'); return null }
  const understanding = m[1].trim()
  const brief = m[2].trim()
  writeFileSync(file('understanding.md'), understanding + '\n')
  append('reflections.jsonl', { ts: now(), words: understanding.split(/\s+/).length, brief: clip(brief, 1500) })
  log('reflected: understanding updated')
  return { understanding, brief }
}

// A one-shot Claude answer with no tools, for summaries.
async function ask(prompt) {
  let out = ''
  try {
    for await (const msg of query({
      prompt,
      options: { tools: [], maxTurns: 1, settingSources: [], persistSession: false, model: config.memoryModel, cwd: dir, env: { ...process.env, ANTON_CHILD: '1' } },
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
