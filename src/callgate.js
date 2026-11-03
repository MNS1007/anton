// Decides whether another agent's post is worth phoning the owner about.
// Fixed rules (addressed to Anton, marked urgent) can't tell "Nithin must approve
// this by 5 pm" from "FYI, informational, no need to call": both are addressed to
// Anton. So a small model reads the post with the recent porch thread and the
// owner's notes and picks one of:
//   call: work the owner is waiting on is done or has a result, an agent is blocked
//         or needs them, something is at risk, or they asked to hear about it
//   hold: progress with nothing finished, news, or posts they said not to call about
//   skip: thanks, chatter, repeats, or questions agents can settle without them
// The owner is not watching the agents, so a finished result is worth a call:
// without one they can't tell done from stuck. When the model can't decide, the
// answer is hold.
import { query } from './sdk.js'
import { config } from './config.js'
import { log } from './log.js'

const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + '...' : s }

export function gatePrompt({ m, recent = [], notes = '' }) {
  const u = config.userName
  return `You decide whether ${config.assistantName}, ${u}'s phone assistant, should phone ${u} now about a post from one of ${u}'s other agents.

${u} is not watching the agents; ${config.assistantName}'s calls are how ${u} knows what is going on. Without a call, ${u} cannot tell finished work from stuck work, so finished work is a call even when nothing needs deciding.

Answer "call" when:
- work an agent was doing for ${u} is finished, or has a result, so ${u} can say what is next
- an agent is blocked, failed, or needs ${u}'s decision, approval or answer
- a deadline, money, or access is at risk
- it is something ${u} asked to hear about or be called back about (see the recent calls)
Answer "hold" when it is worth telling ${u} but not worth a call on its own: progress on work that is still going with nothing finished, news, plans, or a kind of post ${u} said not to be called about.
Answer "skip" when ${u} has nothing to learn from it: thanks, chatter, a repeat of something already said, something already resolved, or agents asking each other or ${config.assistantName} questions they can settle without ${u}.
Respect what the post or the recent thread says about calling: if ${u} or an agent passing on ${u}'s wishes says not to call about this kind of post, do not call. A post saying something is urgent is a reason to consider calling, not a rule. A wish about one kind of post (for example job or event status) covers only that kind; it does not stop calls about finished work.

${notes ? `What ${config.assistantName} knows about ${u}, their preferences and recent calls:\n${clip(notes, 14000)}\n\n` : ''}Recent porch posts around it, oldest first:
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
