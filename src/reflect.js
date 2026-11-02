// Keeps Anton's understanding of the user current, and tells the user's other
// agents what the user is doing with the rest of them.
//
// Every so often, when Anton has learned something new (a call, a note, a task),
// it reflects: memory.reflect() rewrites understanding.md, and the short brief
// it writes goes on porch in the context room, where every agent can read it.
import { config } from './config.js'
import { log } from './log.js'
import * as memory from './memory.js'
import * as hub from './hub.js'
import * as directory from './agents.js'

const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + '...' : s }
let running = null
let timer = null

// What each agent is for and has been doing, for the reflection to read.
async function agentsDigest() {
  const { agents } = await directory.listAgents().catch(() => ({ agents: [] }))
  const lines = []
  for (const a of agents) {
    lines.push(`- ${a.name} (${a.kind})${a.purpose ? `, for ${a.purpose}` : ''}: ${a.state || ''} ${a.lastResult ? `Last result: ${a.lastResult}` : ''}`.trim())
    if (a.kind === 'agent on porch' && hub.enabled) {
      const posts = await hub.list({ from: a.name, limit: 3 }).catch(() => [])
      for (const p of posts) lines.push(`  - ${p.ts.slice(0, 10)} in ${p.room}: ${clip(p.text, 600)}`)
    }
  }
  return lines.join('\n')
}

// Reflect now. Shares the brief when it changed. Returns what was written.
export function reflectNow({ reflect = memory.reflect, post = hub.post } = {}) {
  if (running) return running
  running = (async () => {
    const before = memory.lastReflection()?.brief || ''
    const r = await reflect({ agentsDigest: await agentsDigest() })
    if (!r) return null
    if (r.brief && hub.enabled && config.porchContextRoom && clip(r.brief, 1500) !== before) {
      await post({
        room: config.porchContextRoom,
        kind: 'briefing',
        text: `What ${config.userName} is working on, and what each agent is doing (from ${config.assistantName}, ${new Date().toISOString().slice(0, 10)}). Read this before you start a task.\n\n${r.brief}`,
      }).then(() => log(`shared the brief in porch room ${config.porchContextRoom}`))
        .catch(err => log(`could not share the brief: ${err.message}`))
    }
    return r
  })().finally(() => { running = null })
  return running
}

// Due when something new was learned and the last reflection is old enough,
// or once a day regardless so agent activity is picked up.
export function due(now = Date.now()) {
  const n = memory.newSinceReflection()
  const age = n.since ? (now - Date.parse(n.since)) / 3600e3 : Infinity
  const fresh = n.notes + n.calls + n.tasks
  return (fresh > 0 && age >= config.reflectHours) || age >= 24
}

export function start() {
  if (!config.reflectHours) return
  const check = () => { if (due()) reflectNow().catch(err => log(`reflection failed: ${err.message}`)) }
  timer = setInterval(check, 15 * 60e3)
  timer.unref?.()
  setTimeout(check, 60e3).unref?.()
}

export function stop() { clearInterval(timer) }
