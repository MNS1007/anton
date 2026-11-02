// Keeps the shared memory about the user current.
//
// The memory is one document on porch that every agent reads and edits. Every so
// often, when Anton has learned something new (a call, a note, a task), it
// reflects: it reads the shared document, folds in what it learned, and writes
// it back. me.md on the laptop is a copy, so calls and Claude tasks can use it
// even when porch is down.
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

// The shared document, or null when porch is off or has none yet.
async function readShared(getMemory) {
  if (getMemory === hub.getMemory && !hub.enabled) return null
  try { return await getMemory() } catch (err) { log(`could not read the shared memory: ${err.message}`); return null }
}

// Bring me.md in line with porch (on start, and when another agent edits it).
export async function pull({ getMemory = hub.getMemory } = {}) {
  const shared = await readShared(getMemory)
  if (shared?.text) memory.setPortrait(shared.text)
  return shared
}

// Reflect now and write the result back to porch. If another agent saved in the
// meantime, start again from their version once. Returns what was written.
export function reflectNow({ reflect = memory.reflect, getMemory = hub.getMemory, putMemory = hub.putMemory } = {}) {
  if (running) return running
  running = (async () => {
    const digest = await agentsDigest()
    for (let attempt = 0; attempt < 2; attempt++) {
      const shared = await readShared(getMemory)
      const r = await reflect({ shared: shared?.text ?? null, agentsDigest: digest })
      if (!r) return null
      if (!shared) return r
      try {
        await putMemory(r.memory, shared.version)
        log('shared memory updated on porch')
        return r
      } catch (err) {
        if (err.status !== 409) { log(`could not save the shared memory: ${err.message}`); return r }
        log('someone else edited the shared memory first; reflecting again from theirs')
      }
    }
    return null
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
  pull().catch(() => {})
  if (!config.reflectHours) return
  const check = () => { if (due()) reflectNow().catch(err => log(`reflection failed: ${err.message}`)) }
  timer = setInterval(check, 15 * 60e3)
  timer.unref?.()
  setTimeout(check, 60e3).unref?.()
}

export function stop() { clearInterval(timer) }
