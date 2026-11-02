// Scores one benchmark call. Pure functions over what the runner recorded, so they
// can be tested without a phone or a model.
//
// A recorded call looks like:
//   turns:  [{ who: 'user' | 'anton', text, start, end }]   times in ms from call start
//   tools:  [{ at, name, args }]
//   speech: [{ at, loud }]                                    Anton's audio, one entry per 20 ms
//   userAudio: [{ start, end }]                               when the caller's lines were playing
// and a scenario's expectations:
//   requests: [{ id, say, tool, target }]   tool: ask_agent | ask_claude | call_me_back | ...
//                                           target: agent or session name the request is for

const words = s => new Set(String(s).toLowerCase().match(/[a-z0-9']{3,}/g) || [])
export function overlap(a, b) {
  const A = words(a), B = words(b)
  if (!A.size || !B.size) return 0
  let n = 0
  for (const w of A) if (B.has(w)) n++
  return n / Math.min(A.size, B.size)
}

// Anton turns that say the same thing as one of its last four turns.
export function repeats(turns, { window = 4, threshold = 0.6, minWords = 6 } = {}) {
  const said = turns.filter(t => t.who === 'anton').map(t => t.text)
  const hits = []
  for (let i = 0; i < said.length; i++) {
    if (words(said[i]).size < minWords) continue
    for (let j = Math.max(0, i - window); j < i; j++) {
      if (overlap(said[i], said[j]) >= threshold) { hits.push(said[i]); break }
    }
  }
  return hits
}

const FILLER = /^\s*(checking|one sec|one second|let me check|give me a (sec|second|moment)|hang on|i'?ll check)/i

// "Checking" with no lookup or action within a few seconds of it.
export function fillers(turns, tools, { withinMs = 6000 } = {}) {
  return turns.filter(t => t.who === 'anton' && FILLER.test(t.text) && !tools.some(c => c.at >= t.start - 1000 && c.at <= t.start + withinMs)).map(t => t.text)
}

// Time from the end of each caller line to Anton's next speech.
export function delays(userAudio, speech) {
  const out = []
  for (const u of userAudio) {
    const next = speech.find(f => f.loud && f.at > u.end)
    if (next) out.push(next.at - u.end)
  }
  return out
}

// Anton starting to speak while a caller line is playing (not counting the caller
// cutting into Anton, which is the caller's choice).
export function talkOvers(userAudio, speech) {
  let n = 0
  for (const u of userAudio) {
    const before = speech.filter(f => f.at > u.start - 400 && f.at <= u.start).some(f => f.loud)
    if (before) continue // Anton was already talking; the caller cut in
    const loudDuring = speech.filter(f => f.at > u.start + 300 && f.at < u.end).filter(f => f.loud).length
    if (loudDuring * 20 >= 400) n++
  }
  return n
}

const READS = new Set(['get_status', 'list_agents', 'agent_work', 'hub_read', 'recall', 'find_claude_sessions'])
const matches = (call, req) => call.name === req.tool && (!req.target || JSON.stringify(call.args || {}).toLowerCase().includes(String(req.target).toLowerCase()))

// A request counts as handled when a matching action was taken, or Anton asked
// about it (a question naming the target) and it was not left hanging.
export function requestOutcomes(requests, tools, turns) {
  return requests.map(req => {
    if (tools.some(c => matches(c, req))) return { id: req.id, outcome: 'done' }
    const asked = turns.some(t => t.who === 'anton' && t.text.includes('?') && (!req.target || t.text.toLowerCase().includes(String(req.target).toLowerCase())))
    return { id: req.id, outcome: asked ? 'asked' : 'dropped' }
  })
}

// Actions that match no request: something done that nobody asked for.
export function wrongActions(requests, tools) {
  return tools.filter(c => !READS.has(c.name) && c.name !== 'end_call' && !requests.some(r => matches(c, r))).map(c => c.name)
}

const median = xs => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }
const p90 = xs => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * 0.9))] }

export function score(rec, scenario) {
  const outcomes = requestOutcomes(scenario.expect?.requests || [], rec.tools, rec.turns)
  const d = delays(rec.userAudio, rec.speech)
  return {
    dropped: outcomes.filter(o => o.outcome === 'dropped').length,
    requests: outcomes.length,
    repeats: repeats(rec.turns).length,
    fillers: fillers(rec.turns, rec.tools).length,
    talkOvers: talkOvers(rec.userAudio, rec.speech),
    wrongActions: wrongActions(scenario.expect?.requests || [], rec.tools).length,
    delayMedianMs: median(d),
    delayP90Ms: p90(d),
    outcomes,
  }
}
