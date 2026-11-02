// Anton's memory, as plain files in ANTON_HOME/memory:
//   profile.md       what Anton should always know about you (you can edit it)
//   notes.jsonl      things you asked it to remember, and facts it learned from calls
//   episodes.jsonl   a short summary of each call
//   tasks.jsonl      every Claude task and how it ended
//   calls/           full call transcripts
//   forgotten.jsonl  what you asked it to forget, so it is not learned again
//   me.md            the shared memory about you (who you are, how you think, what you want), kept in step with porch
//   reflections.jsonl when it was rewritten
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
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
  // Prefixes count only from 4 letters, so "android" does not match "and".
  const near = (a, b) => b.length >= 4 && a.startsWith(b)
  for (const w of q) if (t.has(w) || [...t].some(x => near(x, w) || near(w, x))) hit++
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
  // Matching lines of the portrait go too, right away; the next reflection is
  // told never to bring them back.
  const lines = readPortrait().split('\n')
  // A portrait line holds a lot, so it goes only on a close match.
  const dropLines = lines.filter(l => /\w/.test(l) && !l.trim().startsWith('#') && score(description, l) >= 0.75)
  if (best < 0.34 && !dropLines.length) return { ok: false, reason: 'Nothing I remember matches that.' }
  // Everything close to the best match goes, so "forget my old address" removes every version of it.
  const gone = best < 0.34 ? [] : scored.filter(x => x.s >= Math.max(0.34, best - 0.15)).map(x => x.n)
  const keep = notes.filter(n => !gone.includes(n))
  writeFileSync(file('notes.jsonl'), keep.map(n => JSON.stringify(n)).join('\n') + (keep.length ? '\n' : ''))
  if (dropLines.length) writeFileSync(file('me.md'), lines.filter(l => !dropLines.includes(l)).join('\n').trim() + '\n')
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

// What gets put in front of the voice model and Claude. Kept to about 5k tokens.
export function context({ calls = true } = {}) {
  const parts = []
  const profile = readFileSync(file('profile.md'), 'utf8').trim()
  if (profile && profile !== PROFILE_TEMPLATE.trim()) parts.push(`Profile:\n${clip(profile, 3000)}`)
  const portrait = readPortrait()
  if (portrait) parts.push(`Who ${config.userName} is (your portrait of them; background for understanding them, never recite it):\n${clip(portrait, 7000)}`)
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
  append('tasks.jsonl', { ts: now(), session, source, task: clip(task, 300), result: clip(result, aboutUser(task) ? 6000 : 1500), failed: failed ? clip(failed, 300) : null })
}

// Tasks that ask an agent about the user; their answers feed the portrait.
function aboutUser(task) {
  const u = config.userName.replace(/[^\w]/g, '')
  return new RegExp(`\\b(about|of|understand\\w*) (${u}|me|him|her|them)\\b|who ${u} is|\\b${u}'s (goals|life|work|style)`, 'i').test(String(task || ''))
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

// Reflection: the memory about the user is one shared document. On porch every
// agent reads and edits it; Anton keeps a copy in me.md and folds in what it has
// learned (calls, notes, tasks, answers) on each pass. It is one coherent picture
// of who the user is, how they think and what they want, with no record of who
// said what. Private things stay in Anton's own notes, never in this document.

// Earlier versions called it understanding.md.
if (existsSync(file('understanding.md')) && !existsSync(file('me.md'))) renameSync(file('understanding.md'), file('me.md'))
const readPortrait = () => { try { return readFileSync(file('me.md'), 'utf8').trim() } catch { return '' } }

// The shared copy changed on porch: keep the local one the same.
export function setPortrait(text) {
  writeFileSync(file('me.md'), String(text || '').trim() + '\n')
}

export const lastReflection = () => readLines('reflections.jsonl').at(-1) || null

// Has anything been learned since the last reflection?
export function newSinceReflection() {
  const last = readLines('reflections.jsonl').at(-1)?.ts || ''
  const fresh = name => readLines(name).filter(x => x.ts > last).length
  return { since: last || null, notes: fresh('notes.jsonl'), calls: fresh('episodes.jsonl'), tasks: fresh('tasks.jsonl') }
}

// shared: the current shared memory text (from porch), or null to use me.md.
// agentsDigest: what each agent is for and doing.
// Returns { memory } or null when the model gave nothing usable.
export async function reflect({ shared = null, agentsDigest = '', askFn = ask } = {}) {
  const u = config.userName
  const profile = readFileSync(file('profile.md'), 'utf8').trim()
  const current = shared ?? readPortrait()
  const material = [
    `The shared memory as it stands (every agent edits it, and ${u} may have corrected it; keep what is still true):\n${current || '(empty)'}`,
    `Profile, written by ${u} (always right; never contradict it):\n${profile === PROFILE_TEMPLATE.trim() ? '(empty)' : clip(profile, 4000)}`,
    `Notes (things ${u} said or asked to remember), oldest first:\n${clip(readLines('notes.jsonl').slice(-80).map(n => `- ${n.ts.slice(0, 10)} ${n.text}`).join('\n'), 8000) || '(none)'}`,
    `Call summaries:\n${clip(readLines('episodes.jsonl').slice(-20).map(e => `- ${e.ts.slice(0, 10)} ${e.summary}`).join('\n'), 6000) || '(none)'}`,
    `Tasks ${u} gave to agents:\n${clip(readLines('tasks.jsonl').slice(-30).map(t => `- ${t.ts.slice(0, 10)} [${t.session}] ${clip(t.task, 160)}: ${t.failed ? 'ended early' : 'done'}`).join('\n'), 5000) || '(none)'}`,
    `What agents answered when asked about ${u}:\n${clip(readLines('tasks.jsonl').filter(t => !t.failed && t.result && aboutUser(t.task)).slice(-6).map(t => `- ${t.ts.slice(0, 10)}:\n${clip(t.result, 3000)}`).join('\n'), 12000) || '(none)'}`,
    `Forgotten at ${u}'s request (never write these or anything like them):\n${clip(readLines('forgotten.jsonl').map(f => `- ${f.description}`).join('\n'), 2000) || '(nothing)'}`,
    `What ${u}'s agents are doing (about the agents only, never facts about ${u}):\n${clip(agentsDigest, 6000) || '(nothing)'}`,
  ].join('\n\n')
  const out = await askFn(`You keep the shared memory about ${u}: one document that ${config.assistantName} and all of ${u}'s other agents read as background, so each of them understands ${u} as a person. Nobody reads it out to ${u}. Today is ${now().slice(0, 10)}.

Rewrite the document from the material below. It is a picture of a person, not a status report or a log: who ${u} is, how they think, what they want from work and life. Keep what is still true, especially anything ${u} corrected, deepen it with what is new, fix what is now wrong, and change it when ${u} changes.

Use these headings, in this order:
# Who ${u} is
## How ${u} thinks
## What ${u} wants (in work and in life)
## Values and beliefs
## What ${u} is building, and why
## Technical side
## How ${u} works
## How to work with ${u}
## Right now (current focus, a few lines; this part changes often)
## ${u}'s agents (what each is for and how ${u} uses it)
## Open questions (things that do not fit together yet, or that nobody knows)

Rules:
- One voice. Write it as plain statements about ${u}. Never say who said or wrote something ("per X", "according to Y", "X says"). Where sources disagree, ${u}'s own words (profile, notes, calls) win; otherwise keep the most recent and specific.
- Only state what the material supports. Where it is thin, say less, or note it under open questions. Never invent.
- Leave out task status, commit ids and step-by-step history. A project's stage is enough.
- Nothing private, because agents running in other companies' clouds read it: no health, money, family, other people's personal details, customer names, contact details, credentials, or anything said in confidence.
- Use ${u}'s name or they, never guessed pronouns. At most 1200 words.

Reply with only the document, starting with "# Who ${u} is".

${material}`)
  const text = String(out || '').trim()
  if (!text.startsWith('#') || text.split(/\s+/).length < 40) { log('reflection gave nothing usable'); return null }
  setPortrait(text)
  append('reflections.jsonl', { ts: now(), words: text.split(/\s+/).length })
  log('reflected: shared memory rewritten')
  return { memory: text }
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
