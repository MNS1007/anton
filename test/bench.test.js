import './setup.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sanitize } from '../scripts/bench/sanitize.js'
import { repeats, fillers, delays, talkOvers, requestOutcomes, wrongActions, score } from '../scripts/bench/metrics.js'
import { summarize, gate, table } from '../scripts/bench/gate.js'

test('sanitize removes contact details, money and flagged names, keeps the owner', () => {
  const s = sanitize('Email jane.doe@acme.com or call +1 (510) 555-0199, see https://x.io/a. We raised $10M with Jane at Acme. Sam agreed.', { terms: ['Jane', 'Acme', 'Sam'], keep: ['Sam'] })
  assert.equal(s, 'Email [email] or call [phone], see [link] We raised [amount] with [name] at [name]. Sam agreed.')
})

const T = (who, text, start, end = start + 1000) => ({ who, text, start, end })

test('repeats: the same thing said again within four turns', () => {
  const turns = [T('anton', 'It is a contact aware robot work evaluator that checks robot runs', 0), T('user', 'say that', 2000), T('anton', 'It is a contact aware robot work evaluator that checks robot runs', 3000), T('anton', 'Okay.', 5000)]
  assert.equal(repeats(turns).length, 1)
})

test('fillers: "checking" counts only when no lookup follows', () => {
  const turns = [T('anton', 'Checking.', 1000), T('anton', 'One sec, let me look.', 9000)]
  assert.equal(fillers(turns, [{ at: 2000, name: 'get_status' }]).length, 1)
})

test('delays and talking over the caller', () => {
  const frames = (from, to, loud) => Array.from({ length: (to - from) / 20 }, (_, i) => ({ at: from + i * 20, loud }))
  const speech = [...frames(0, 1000, false), ...frames(1000, 1500, true), ...frames(1500, 4000, false), ...frames(4400, 5400, true)]
  const userAudio = [{ start: 0, end: 800 }, { start: 3800, end: 6000 }]
  assert.deepEqual(delays(userAudio, speech), [200])
  assert.equal(talkOvers(userAudio, speech), 1, 'Anton started while the second line was playing')
})

test('requests: done, asked about, or dropped; and actions nobody asked for', () => {
  const reqs = [{ id: 'a', tool: 'ask_agent', target: 'grokbot' }, { id: 'b', tool: 'ask_agent', target: 'muse' }, { id: 'c', tool: 'ask_agent', target: 'claude-ai' }]
  const tools = [{ at: 1, name: 'ask_agent', args: { agent: 'grokbot', message: 'x' } }, { at: 2, name: 'remember', args: {} }, { at: 3, name: 'get_status', args: {} }]
  const turns = [T('anton', 'What should I ask Muse?', 5)]
  assert.deepEqual(requestOutcomes(reqs, tools, turns).map(o => o.outcome), ['done', 'asked', 'dropped'])
  assert.deepEqual(wrongActions(reqs, tools), ['remember'])
})

test('gate ships only real improvements and never more drops', () => {
  const s = (o) => ({ dropped: 0, repeats: 0, fillers: 0, talkOvers: 0, wrongActions: 0, delayMedianMs: 5000, delayP90Ms: 9000, ...o })
  const base = summarize({ one: [s({ dropped: 1, repeats: 2 }), s({ dropped: 1, repeats: 2 })] })
  const better = gate(summarize({ one: [s({ dropped: 0, repeats: 0 }), s({ dropped: 0, repeats: 0 })] }), base)
  assert.equal(better.ship, true)
  const moreDrops = gate(summarize({ one: [s({ dropped: 2, repeats: 0 }), s({ dropped: 2, repeats: 0 })] }), base)
  assert.equal(moreDrops.ship, false)
  assert.match(moreDrops.reason, /dropped requests went up/)
  assert.match(table(better.rows), /\| dropped requests \| 1 \| 0 \| better \|/)
  assert.equal(gate(base, null).ship, false)
})

test('score puts it together', () => {
  const rec = { turns: [T('anton', 'Sent it to grokbot.', 2000)], tools: [{ at: 1500, name: 'ask_agent', args: { agent: 'grokbot' } }], speech: [{ at: 2100, loud: true }], userAudio: [{ start: 0, end: 1000 }] }
  const r = score(rec, { expect: { requests: [{ id: 'a', tool: 'ask_agent', target: 'grokbot' }] } })
  assert.equal(r.dropped, 0)
  assert.equal(r.delayMedianMs, 1100)
})
