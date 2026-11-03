// A stand-in for the Agent SDK, for the worker tests: no network, no Claude.
// The prompt steers a turn: [ms=N] how long it takes, [ask:<command>] asks
// permission to run <command> halfway through ([ask2:a|b] asks for two at once),
// [fail] ends with an error,
// [reply=<text>] replies with <text> (a follow-up with another agent's answer
// replies "final <id>").
// A resumed turn ("Your previous turn was interrupted ...") continues the
// conversation it resumes, so it does what that conversation was last asked.
// Every turn is written to ANTON_HOME/stub/calls.jsonl for the tests to check.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const dir = () => join(process.env.ANTON_HOME, 'stub')
const tag = text => /\[id=([^\]]+)\]/.exec(text)?.[1] || String(text).split('\n')[0].slice(0, 80)

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'))
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')) })
  })
}

export function query({ prompt, options = {} }) {
  return turn(String(prompt), options)
}

async function* turn(prompt, options) {
  mkdirSync(dir(), { recursive: true })
  const resumed = /^Your previous turn was interrupted by a restart/.test(prompt)
  const sid = options.resume && !options.forkSession ? options.resume : randomUUID()
  let asked = prompt
  if (resumed) { try { asked = JSON.parse(readFileSync(join(dir(), `${sid}.json`), 'utf8')).prompt } catch {} }
  else writeFileSync(join(dir(), `${sid}.json`), JSON.stringify({ prompt }))
  appendFileSync(join(dir(), 'calls.jsonl'), JSON.stringify({ pid: process.pid, sid, resume: options.resume || null, resumed, tag: tag(asked), prompt: prompt.slice(0, 200) }) + '\n')
  yield { type: 'system', subtype: 'init', session_id: sid }
  const signal = options.abortController?.signal
  const ms = Number(/\[ms=(\d+)\]/.exec(asked)?.[1] || 50)
  await sleep(ms / 2, signal)
  const ask = /\[ask:([^\]]+)\]/.exec(asked)
  // [ask2:a|b]: two tool calls at once, as Claude makes parallel tool calls.
  const ask2 = /\[ask2:([^|\]]+)\|([^\]]+)\]/.exec(asked)
  if (ask || ask2) {
    const answers = await Promise.all((ask ? [ask[1]] : [ask2[1], ask2[2]]).map(command => options.canUseTool('Bash', { command }, { signal })))
    if (signal?.aborted) throw new Error('aborted')
    const answer = { behavior: answers.every(a => a.behavior === 'allow') ? 'allow' : 'deny' }
    if (answer.behavior !== 'allow') {
      yield { type: 'result', subtype: 'success', result: `denied ${tag(asked)}`, session_id: sid }
      return
    }
  }
  await sleep(ms / 2, signal)
  yield { type: 'assistant', session_id: sid, message: { content: [{ type: 'text', text: `working on ${tag(asked)}` }] } }
  if (/\[fail\]/.test(asked)) {
    yield { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'stub failure', session_id: sid }
    return
  }
  const reply = /answered your question/.test(asked) ? `final ${tag(asked)}` : /\[reply=([^\]]+)\]/.exec(asked)?.[1] || `done ${tag(asked)}`
  yield { type: 'result', subtype: 'success', result: reply, session_id: sid }
}

export async function listSessions() { return [] }
export async function getSessionInfo() { return null }
