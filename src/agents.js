// All of the user's agents in one place: Claude Code sessions on this laptop and
// the other agents on porch (Grok Bot, Muse, ...). Anton asks any of them for
// work the same way, and can read in full what each one has done.
import { config } from './config.js'
import { agent } from './runner.js'
import * as hub from './hub.js'

const SELF = () => new Set([hub.self(), config.porchBoss])
const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + '...' : s }
const slug = name => String(name || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)

// Porch agents other than the user and Anton itself. Agents that stand in for a
// Claude Code terminal (linked sessions) are listed with the Claude sessions.
async function porchAgents() {
  if (!hub.enabled) return []
  const linked = new Set(agent.list().map(s => s.porchAgent).filter(Boolean))
  const skip = SELF()
  return (await hub.agents()).filter(a => !skip.has(a.name) && !linked.has(a.name))
}

export async function listAgents() {
  const claude = agent.list().map(s => ({
    name: s.name,
    kind: s.porchAgent ? `live Claude Code session on the laptop, reached through porch as ${s.porchAgent} (it keeps its own full context; it is not a copy)` : 'Claude Code session on the laptop, run by Anton',
    purpose: s.purpose,
    state: s.waitingForPermission ? `waiting for permission: ${s.waitingForPermission}` : s.running ? `working on "${s.task}"` : 'idle',
    lastResult: clip(s.lastResult, 300),
  }))
  let others = []
  try {
    others = await Promise.all((await porchAgents()).map(async a => {
      const [last] = await hub.list({ from: a.name, limit: 1 }).catch(() => [])
      return {
        name: a.name,
        kind: 'agent on porch',
        reach: 'Runs on its own schedule. A task posted for it is picked up the next time it runs; Anton tells you when it replies.',
        lastSeen: a.lastSeen,
        online: a.online,
        latest: last ? `posted in ${last.room} at ${last.ts.slice(0, 16).replace('T', ' ')} (read it with agent_work)` : 'nothing posted yet',
      }
    }))
  } catch (err) {
    others = [{ name: 'porch', kind: 'error', state: `could not read porch: ${err.message}` }]
  }
  return { agents: [...claude, ...others] }
}

// Send a task or question to any agent. A porch agent gets a session that stands
// for it (made on first use), so its reply comes back like any Claude result.
export async function askAgent(name, message, opts = {}) {
  const n = String(name || '').trim()
  if (!n) return { ok: false, reason: 'Say which agent.' }
  if (!String(message || '').trim()) return { ok: false, reason: 'The message is empty. Call again with the message written in message.' }
  if (agent.status(n).name) return agent.ask(message, { ...opts, session: n })
  const porch = (await porchAgents().catch(() => [])).find(a => a.name.toLowerCase() === n.toLowerCase() || slug(a.name) === slug(n))
  if (!porch) {
    const known = (await listAgents()).agents.map(a => a.name).join(', ')
    return { ok: false, reason: `No agent named ${n}. Agents: ${known}.` }
  }
  const linked = agent.list().find(s => s.porchAgent === porch.name)
  const session = linked ? linked.name : agent.linkAgent({ name: porch.name, agent: porch.name, purpose: `the ${porch.name} agent on porch` }).name
  if (!session) return { ok: false, reason: `Could not reach ${porch.name}.` }
  const r = agent.ask(message, { ...opts, session })
  return r.ok ? { ...r, note: `Posted for ${porch.name} on porch. It picks this up the next time it runs, and I will pass on its reply.` } : r
}

// Everything an agent has done recently, in full: porch posts for any agent, and
// the last result for a Claude session. Long, so read it and summarize.
export async function agentWork(name, { query, limit = 5 } = {}) {
  const n = String(name || '').trim()
  const out = { agent: n }
  const s = agent.status(n)
  if (s.name) {
    out.session = { purpose: s.purpose, state: s.running ? `working on "${s.task}"` : 'idle', lastResult: clip(s.lastResult, 6000) }
    if (!s.porchAgent) return out
  }
  if (!hub.enabled) return { ...out, ok: !!s.name, reason: s.name ? undefined : 'porch is off' }
  const from = s.porchAgent || n
  const posts = await hub.list({ from, q: query, limit: Math.min(Number(limit) || 5, 10) })
  let budget = 20000
  out.posts = posts.reverse().map(m => {
    const text = clip(m.text, Math.max(500, Math.min(8000, budget)))
    budget -= text.length
    return { id: m.id, when: m.ts, room: m.room, kind: m.kind, text }
  })
  if (!out.posts.length && !s.name) out.note = `Nothing from ${n} on porch${query ? ` matching "${query}"` : ''}.`
  out.links = [...new Set(out.posts.flatMap(p => p.text.match(/https?:\/\/[^\s)>\]"']+/g) || []))].slice(0, 10)
  return out
}
