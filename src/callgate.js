// Decides whether another agent's post is worth phoning the owner about.
// Fixed rules (addressed to Anton, marked urgent) can't tell "Nithin must approve
// this by 5 pm" from "FYI, informational, no need to call": both are addressed to
// Anton. So a small model reads the post with the recent porch thread and the
// owner's notes and picks one of:
//   call: the owner needs to act or decide soon, and it can't wait for the next call
//   hold: worth telling them, but on the next call or in porch, without ringing
//   skip: already resolved, already known, or noise
// When the model can't decide, the answer is hold: a missed call costs little,
// an unwanted one costs the owner's attention.
import { query } from './sdk.js'
import { config } from './config.js'
import { log } from './log.js'

const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + '...' : s }

export function gatePrompt({ m, recent = [], notes = '' }) {
  const u = config.userName
  return `You decide whether ${config.assistantName}, ${u}'s phone assistant, should phone ${u} now about a post from one of ${u}'s other agents.

Answer "call" only if ${u} needs to act, decide or know something soon and it cannot wait until the next call: a deadline today, a decision only ${u} can make that is blocking work, money or access at risk, or something ${u} asked to be called about.
Answer "hold" if it is worth telling ${u} but can wait: status updates, results, news, plans, FYIs.
Answer "skip" if it is already resolved, repeats something already said, or is just thanks or chatter.
Respect what the post or the recent thread says about calling: if ${u} or an agent passing on ${u}'s wishes says not to call about this kind of post, do not call. A post saying something is urgent is a reason to consider calling, not a rule.

${notes ? `What ${config.assistantName} knows about ${u}'s preferences:\n${clip(notes, 2500)}\n\n` : ''}Recent porch posts around it, oldest first:
${recent.length ? recent.map(r => `- ${r.from} (${r.kind || 'note'}${r.priority === 'high' ? ', high' : ''}): ${clip(r.text, 300)}`).join('\n') : '(none)'}

The post:
from ${m.from}, room ${m.room}, kind ${m.kind || 'note'}, priority ${m.priority || 'normal'}${(m.to || []).length ? `, addressed to ${m.to.join(', ')}` : ''}
${clip(m.text, 2000)}

Reply with only JSON: {"decision": "call" | "hold" | "skip", "reason": "a few words"}`
}

async function ask(prompt) {
  let out = ''
  for await (const msg of query({ prompt, options: { tools: [], maxTurns: 1, settingSources: [], persistSession: false, model: config.memoryModel, env: { ...process.env, ANTON_CHILD: '1' } } })) {
    if (msg.type === 'result' && msg.subtype === 'success') out = msg.result || ''
  }
  return out
}

export async function decide(ctx, { askFn = ask } = {}) {
  try {
    const out = await askFn(gatePrompt(ctx))
    const j = JSON.parse(String(out).replace(/^```(json)?|```$/g, '').trim())
    if (['call', 'hold', 'skip'].includes(j.decision)) return { decision: j.decision, reason: String(j.reason || '').slice(0, 200) }
  } catch (err) {
    log(`call gate: ${err.message}`)
  }
  return { decision: 'hold', reason: 'could not decide, so not ringing' }
}
