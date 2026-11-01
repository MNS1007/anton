// Connects Anton to a porch hub (github.com/MNS1007/porch).
// It watches the hub, takes tasks you send it there, posts Claude's results,
// and phones you when another agent posts something that matters.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { config } from './config.js'
import { log } from './log.js'
import * as agent from './agent.js'

export const enabled = !!(config.porchUrl && config.porchToken)

const auth = { Authorization: `Bearer ${config.porchToken}` }
// Remembers the last message seen, per hub, so nothing is missed across restarts.
const cursorFile = join(config.antonHome, 'porch-cursor-' + createHash('sha256').update(config.porchUrl).digest('hex').slice(0, 8))
let me = { name: 'anton' }
let phoneNotify = null
let calls = { day: '', count: 0 }

async function call(path, opts = {}) {
  const r = await fetch(config.porchUrl + path, { ...opts, headers: { ...auth, 'Content-Type': 'application/json' } })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(body.error || `porch answered ${r.status}`)
  return body
}

export const post = msg => call('/v1/messages', { method: 'POST', body: JSON.stringify(msg) })

export function list(query = {}) {
  const q = Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '')
  return call('/v1/messages?' + new URLSearchParams(q))
}

// Short versions of recent messages, for reading out on a call.
export async function recent({ room, forMe, limit = 8 } = {}) {
  const msgs = await list({ room, to: forMe ? me.name : undefined, limit: Math.min(Number(limit) || 8, 20) })
  return msgs.map(m => ({ id: m.id, from: m.from, room: m.room, kind: m.kind, when: m.ts, text: clip(m.text, 400) }))
}

// Start watching. `notify` places a phone call, or is null when Anton has no phone.
export async function start(notify) {
  phoneNotify = notify
  me = await call('/v1/me')
  log(`connected to porch as ${me.name}`)
  watch().catch(err => log(`porch watcher stopped: ${err.message}`))
}

// Anton's own news (Claude finished, failed or needs permission) goes on the hub too.
export function relay(notice) {
  const kinds = { permission: 'question', failed: 'alert', done: 'note' }
  post({
    room: config.porchRoom,
    kind: kinds[notice.kind] || 'note',
    priority: notice.kind === 'permission' ? 'high' : 'normal',
    to: [config.porchBoss],
    text: notice.text,
  }).catch(err => log(`could not post to porch: ${err.message}`))
}

async function watch() {
  let after = readCursor()
  if (after === null) after = (await list({ limit: 1 })).at(-1)?.id || 0
  for (;;) {
    try {
      const res = await fetch(`${config.porchUrl}/v1/stream?after=${after}`, { headers: auth })
      if (!res.ok) throw new Error(`stream answered ${res.status}`)
      log('watching porch')
      const decoder = new TextDecoder()
      let buf = ''
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true }).replace(/\r/g, '')
        let i
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i)
          buf = buf.slice(i + 2)
          const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n')
          if (!data) continue
          let m
          try { m = JSON.parse(data) } catch { continue }
          if (!m.id || m.id <= after) continue
          after = m.id
          writeCursor(after)
          if (m.from === me.name) continue
          try { await onMessage(m) } catch (err) { log(`porch message ${m.id}: ${err.message}`) }
        }
      }
      log('porch stream closed')
    } catch (err) {
      log(`porch stream: ${err.message}`)
    }
    await new Promise(r => setTimeout(r, 5000))
  }
}

async function onMessage(m) {
  const forMe = m.to.includes(me.name)
  // Messages from you that name Anton are instructions. Other agents only inform.
  if (m.from === config.porchBoss) {
    if (forMe) await command(m)
    return
  }
  if (phoneNotify && worthACall(m, forMe)) {
    const ring = underDailyCap()
    if (!ring) log(`porch call limit reached today; ${m.from}'s message waits for the next call`)
    phoneNotify({ kind: 'hub', ring, text: `${m.from} posted in ${m.room}: ${clip(m.text, 600)}` })
  }
}

function worthACall(m, forMe) {
  const rules = config.porchCallOn
  if (rules.includes('none')) return false
  if (rules.includes('all')) return true
  if (rules.includes('for-me') && forMe) return true
  if (rules.includes('urgent') && (m.priority === 'high' || m.kind === 'alert')) return true
  if (rules.includes('questions') && m.kind === 'question') return true
  return false
}

function underDailyCap() {
  const day = new Date().toDateString()
  if (calls.day !== day) calls = { day, count: 0 }
  if (config.porchCallsPerDay && calls.count >= config.porchCallsPerDay) return false
  calls.count++
  return true
}

const reply = (m, text, extra = {}) =>
  post({ room: m.room, reply_to: m.id, to: [m.from], kind: 'answer', text: clip(text, 7500), ...extra })

const HELP = `Post a task for anton and Claude does it in the main session. Other things you can post:
- "<session>: <task>" to use another session
- "sessions" or "status" to see what each session is doing
- "new session <name> in <folder>: <purpose>" (folder is optional)
- "claude sessions" to list Claude Code sessions saved on the laptop, then "attach <id> as <name>"
- "yes" / "no" to answer a permission question (add the session name if several wait)
- "stop <session>", "reset <session>" (fresh conversation), "remove session <name>"`

async function command(m) {
  const text = m.text.trim()
  const pending = agent.pendingPermissions()
  let r

  // yes / no, optionally followed by a session name
  const yes = /^(yes|y|yep|approve|approved|ok|okay|go ahead|do it)\b[\s,.!]*(\S+)?/i.exec(text)
  const no = /^(no|n|nope|deny|don't|do not)\b[\s,.!]*(\S+)?/i.exec(text)
  if (pending.length && (yes || no)) {
    const name = (yes || no)[2]
    const target = name && agent.status(name).name ? name : undefined
    r = agent.answerPermission(!!yes, no ? text : undefined, target)
    return reply(m, r.ok ? (yes ? `Approved. ${r.session} is carrying on.` : `Denied. I told ${r.session}.`) : r.reason)
  }
  if (/^(help|\?)$/i.test(text)) return reply(m, HELP)
  if (/^(status|sessions)\??$/i.test(text)) return reply(m, agent.list().map(sessionLine).join('\n'))
  let x
  if ((x = /^status\s+(\S+)$/i.exec(text))) {
    const s = agent.status(x[1])
    return reply(m, s.name ? sessionLine(s) + (s.lastResult ? `\nLast result: ${s.lastResult}` : '') : s.reason)
  }
  if ((x = /^stop\b\s*(\S+)?$/i.exec(text))) {
    r = agent.stop(x[1])
    return reply(m, r.ok ? `Stopped ${r.session}.` : r.reason)
  }
  if ((x = /^(?:reset|new conversation)\s*(\S+)?$/i.exec(text))) {
    r = agent.resetSession(x[1])
    return reply(m, r.ok ? r.note : r.reason)
  }
  if ((x = /^remove session\s+(\S+)$/i.exec(text))) {
    r = agent.removeSession(x[1])
    return reply(m, r.ok ? `Removed ${x[1]}.` : r.reason)
  }
  if ((x = /^new session\s+(\S+)(?:\s+in\s+((?:[a-z]:[\\/])?[^:]+?))?\s*(?::\s+([\s\S]+))?$/i.exec(text))) {
    r = agent.createSession({ name: x[1], folder: x[2], purpose: x[3] })
    return reply(m, r.ok ? `Created ${r.name}, working in ${r.folder}. Post "${r.name}: <task>" to use it.` : r.reason)
  }
  if ((x = /^claude sessions\s*(.+)?$/i.exec(text))) {
    const found = await agent.findClaudeSessions({ folder: x[1] })
    if (!found.length) return reply(m, 'No saved Claude Code sessions found there.')
    return reply(m, found.map(f => `${f.id}  ${f.title} (${f.folder}, ${f.lastActive.slice(0, 16).replace('T', ' ')})${f.alreadyAttached ? ' [attached]' : ''}`).join('\n') + '\n\nPost "attach <id> as <name>" to continue one.')
  }
  if ((x = /^attach\s+([0-9a-f-]{36})\s+as\s+(\S+)(?:\s*:\s*([\s\S]+))?$/i.exec(text))) {
    r = await agent.attachSession({ name: x[2], purpose: x[3], claudeSessionId: x[1] })
    return reply(m, r.ok ? `Attached as ${r.name}, in ${r.folder}. It continues as a copy, so your terminal is not disturbed. Post "${r.name}: <task>" to use it.` : r.reason)
  }
  if (pending.length) {
    return reply(m, `Claude is waiting for a yes or no first: ${pending.map(p => `${p.session}: ${p.summary}`).join('; ')}`)
  }

  // "<session>: task" picks a session; anything else goes to main.
  let session = 'main'
  let task = text
  if ((x = /^([a-z0-9-]{1,40})\s*:\s+([\s\S]+)$/i.exec(text)) && agent.status(x[1]).name) {
    session = agent.status(x[1]).name
    task = x[2]
  }
  const prompt = `[Task sent through the porch hub by ${m.from}. Your final reply is posted back to the hub as text, so it can be a little longer than a spoken reply.]\n\n${task}`
  r = agent.ask(prompt, {
    session,
    label: task,
    queue: true,
    onDone: (result, failed) => reply(m, failed ? `[${session}] That task ended early: ${failed}` : `[${session}] ${result}`, failed ? { kind: 'alert' } : {}),
  })
  if (!r.ok) return reply(m, r.reason)
  const ahead = r.queued ? r.queued - 1 : 0
  return reply(m, r.queued ? `Got it. ${session} is busy, so this waits${ahead ? ` behind ${ahead} other task(s)` : ' and starts next'}.` : `On it, in ${session}.`, { kind: 'note' })
}

function sessionLine(s) {
  const state = s.waitingForPermission ? `waiting for your yes or no: ${s.waitingForPermission}`
    : s.running ? `working on "${s.task}" (${s.minutesRunning} min)` : 'idle'
  return `${s.name}${s.purpose ? ` (${s.purpose})` : ''}: ${state}${s.queued ? `, ${s.queued} waiting` : ''}`
}

function readCursor() {
  try { return Number(readFileSync(cursorFile, 'utf8')) || 0 } catch { return null }
}

function writeCursor(id) {
  try {
    mkdirSync(config.antonHome, { recursive: true })
    writeFileSync(cursorFile, String(id))
  } catch {}
}

function clip(s, n) {
  s = String(s || '')
  return s.length > n ? s.slice(0, n) + '...' : s
}
