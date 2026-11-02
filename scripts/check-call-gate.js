// Checks the call gate with the real model on posts like the ones Anton really
// gets, each with the decision a person would make. Run: npm run check-call-gate
// A case passes when the model's decision is in its allowed set.
import { decide } from '../src/callgate.js'

const fyi = 'FYI from Nithin: I will post application and event status updates in the jobs room from time to time. These are informational. Please do not call Nithin about them. Also, the Founders Inc question is resolved; claude-code/renfort sent the link and both Luma requests are submitted.'
const jobs = 'Applications status (Grok Bot, Nov 2). Jobs applied: 16 companies. Founder emails sent to 13. No replies yet. Events: Founders Inc Open Campus (Nov 5) and MakerMods hackathon (Nov 7-8), both pending host approval. Informational only, no need to call Nithin about these.'
const CASES = [
  { name: 'FYI that says do not call (the post that rang)', allowed: ['hold', 'skip'], m: { from: 'grokbot', room: 'dm:anton+grokbot', kind: 'note', to: ['anton'], text: fyi } },
  { name: 'status update marked informational', allowed: ['hold', 'skip'], m: { from: 'grokbot', room: 'jobs', kind: 'note', to: ['anton'], text: jobs } },
  { name: 'already-resolved follow-up', allowed: ['skip', 'hold'], recent: [{ from: 'claude-code/renfort', text: 'Sent grokbot the Founders Inc Luma link.' }], m: { from: 'grokbot', room: 'dm:anton+grokbot', kind: 'note', to: ['anton'], text: 'Thanks, got the Luma link, all set.' } },
  { name: 'deadline today needing his decision', allowed: ['call'], m: { from: 'grokbot', room: 'dm:anton+grokbot', kind: 'alert', priority: 'high', to: ['anton'], text: 'The host approved Nithin for Founders Inc Open Campus. He has to confirm attendance by 6 pm today or the spot goes to the waitlist. Should I confirm?' } },
  { name: 'blocking approval only he can give', allowed: ['call', 'hold'], m: { from: 'claude-code/vision-24h', room: 'dm:anton+claude-code/vision-24h', kind: 'question', to: ['anton'], text: 'The 24-hour run is blocked: the next test needs Nithin to approve a $5 Gemini grant on the vault page. Everything else is waiting on that.' } },
  { name: 'agent says urgent, but it is just news', allowed: ['hold', 'skip'], m: { from: 'muse', room: 'research', kind: 'alert', priority: 'high', to: ['anton'], text: 'URGENT: new world model paper out today, worth a read when you have time.' } },
  { name: 'spending already paused, decision can wait', allowed: ['call', 'hold'], m: { from: 'claude-code/main', room: 'dm:anton+claude-code/main', kind: 'alert', priority: 'high', to: ['anton'], text: 'The vault paused the Gemini grant at 80% of its $5 cap after an unexpected burst of calls; something may be looping. Revoke or keep paused?' } },
  { name: 'money being spent right now', allowed: ['call'], m: { from: 'claude-code/main', room: 'dm:anton+claude-code/main', kind: 'alert', priority: 'high', to: ['anton'], text: 'A session is calling the paid API in a loop: the OpenAI grant has spent $38 in the last 10 minutes and is still running. The vault did not pause it because the cap was set to $500. Revoke it?' } },
]

let pass = 0
for (const c of CASES) {
  const r = await decide({ m: c.m, recent: c.recent || [], notes: 'Nithin does not want calls for job and event status updates.' })
  const ok = c.allowed.includes(r.decision)
  if (ok) pass++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${c.name}: ${r.decision} (${r.reason})`)
}
console.log(`\n${pass} of ${CASES.length} cases passed`)
process.exit(pass === CASES.length ? 0 : 1)
