#!/usr/bin/env node
// Lists Anton's Claude Code sessions and opens one in Claude Code. Claude Code
// leaves sessions made through the Agent SDK out of `claude --resume` and
// `--continue` on purpose (only `claude --resume <id>` opens them), so this is
// the list for Anton's sessions:
//   anton-sessions                 every session: state, long run, latest conversation id
//   anton-sessions <name>          that session's conversations, newest first
//   anton-resume <name> [task]     open its latest conversation (or one task's) in Claude Code
// Reads ANTON_HOME/work.db (the worker's record) read-only, or sessions.json
// when the worker has never run. A session that is working right now is opened
// as a copy (--fork-session), so you never write into a conversation Anton is using.
import { DatabaseSync } from 'node:sqlite'
import { existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

const home = resolve((process.env.ANTON_HOME || '~/.anton').replace(/^~(?=$|[\\/])/, homedir()))
const resumeMode = process.argv[2] === 'resume'
const args = process.argv.slice(process.argv[2] === 'resume' ? 3 : 2)

const ago = ms => {
  if (!ms) return '-'
  const m = Math.round((Date.now() - ms) / 60_000)
  return m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`
}
const time = v => typeof v === 'number' ? v : v ? Date.parse(v) : null

function load() {
  const file = join(home, 'work.db')
  if (existsSync(file)) {
    const db = new DatabaseSync(file, { readOnly: true })
    const sessions = db.prepare('SELECT * FROM sessions ORDER BY last_used DESC').all()
    const runs = Object.fromEntries(db.prepare('SELECT * FROM runs').all().map(r => [r.session, r]))
    const tasks = db.prepare('SELECT id, session, label, status, claude_session_id, started, finished, created FROM tasks ORDER BY id DESC').all()
    return { sessions, runs, tasks, from: 'work.db' }
  }
  const raw = JSON.parse(readFileSync(join(home, 'sessions.json'), 'utf8'))
  const sessions = (Array.isArray(raw) ? raw : Object.values(raw)).map(s => ({ name: s.name, purpose: s.purpose, dir: s.dir, claude_session_id: s.claudeSessionId, last_used: s.lastUsed }))
  return { sessions, runs: {}, tasks: [], from: 'sessions.json' }
}

const { sessions, runs, tasks, from } = load()
const state = name => {
  const t = tasks.filter(t => t.session === name)
  if (t.some(t => t.status === 'running')) return 'working'
  if (t.some(t => t.status === 'queued' || t.status === 'interrupted')) return 'queued'
  return 'idle'
}
const latestId = s => tasks.find(t => t.session === s.name && t.claude_session_id)?.claude_session_id || s.claude_session_id
// The conversation itself lives in Claude Code's folder, not Anton's. After a
// restore from an older backup the id can be known here but its file gone.
const claudeDir = resolve((process.env.CLAUDE_CONFIG_DIR || '~/.claude').replace(/^~(?=$|[\\/])/, homedir()))
const saved = (dir, id) => existsSync(join(claudeDir, 'projects', String(dir).replace(/[^a-zA-Z0-9]/g, '-'), id + '.jsonl'))
const shown = (dir, id) => id ? (saved(dir, id) ? id : id + ' (conversation file missing)') : null
const find = name => {
  const n = String(name || '').toLowerCase()
  return sessions.find(s => s.name === n) || sessions.find(s => s.name.includes(n))
}

function list() {
  if (!sessions.length) return console.log('Anton has no sessions yet.')
  for (const s of sessions) {
    const r = runs[s.name]
    const run = r && r.status !== 'ended' && time(r.until) > Date.now()
      ? `, long run round ${r.rounds}, ${((time(r.until) - Date.now()) / 3_600_000).toFixed(1)} h left` : ''
    console.log(`${s.name}  (${state(s.name)}${run}, used ${ago(time(s.last_used))})`)
    console.log(`  ${s.dir}`)
    if (s.purpose) console.log(`  ${s.purpose.slice(0, 110)}`)
    console.log(`  latest: ${shown(s.dir, latestId(s)) || '(no conversation yet)'}`)
  }
  console.log(`\nOpen one: anton-resume <name>. History: anton-sessions <name>. (from ${from})`)
}

function history(s) {
  const t = tasks.filter(t => t.session === s.name && t.claude_session_id)
  console.log(`${s.name}: ${s.dir}`)
  if (!t.length) return console.log(`  latest: ${s.claude_session_id || '(none)'} (history starts when the worker took over)`)
  for (const x of t.slice(0, 30)) console.log(`  task ${x.id}  ${x.status.padEnd(11)} ${ago(x.started || x.created).padEnd(11)} ${shown(s.dir, x.claude_session_id)}  ${x.label || ''}`)
  if (t.length > 30) console.log(`  ... ${t.length - 30} older`)
  console.log(`\nOpen one: anton-resume ${s.name} <task>`)
}

function open(s, taskId) {
  const t = taskId ? tasks.find(t => t.session === s.name && String(t.id) === String(taskId)) : null
  if (taskId && !t) return fail(`${s.name} has no task ${taskId}. See: anton-sessions ${s.name}`)
  const id = t ? t.claude_session_id : latestId(s)
  if (!id) return fail(`${s.name} has no conversation yet.`)
  if (!saved(s.dir, id)) return fail(`${id} is not in Claude Code's folder (${join(claudeDir, 'projects')}), for example after restoring an older backup. Pick an older one: anton-sessions ${s.name}`)
  const busy = (t ? t.status === 'running' : state(s.name) === 'working')
  const argv = ['--resume', id, ...(busy ? ['--fork-session'] : [])]
  console.log(busy
    ? `${s.name} is working right now, so this opens a copy of ${id}; Anton's conversation is left alone.`
    : `Opening ${s.name} (${id}) in ${s.dir}`)
  const child = spawn('claude', argv, { cwd: existsSync(s.dir) ? s.dir : process.cwd(), stdio: 'inherit', shell: process.platform === 'win32' })
  child.on('exit', code => process.exit(code ?? 0))
}

function fail(msg) { console.error(msg); process.exit(1) }

if (resumeMode) {
  if (!args[0]) fail('Which session? anton-resume <name> [task]. List them with anton-sessions.')
  const s = find(args[0])
  if (!s) fail(`No session called "${args[0]}". List them with anton-sessions.`)
  open(s, args[1])
} else if (args[0]) {
  const s = find(args[0])
  if (!s) fail(`No session called "${args[0]}".`)
  history(s)
} else list()
