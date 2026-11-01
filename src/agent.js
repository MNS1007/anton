// Runs Claude Code through the Agent SDK. One session, one turn at a time.
// Anything worth telling the user goes out through the `notify` callback.
import { query } from '@anthropic-ai/claude-agent-sdk'
import { config } from './config.js'
import { log } from './log.js'

const VOICE_NOTE = `You are being driven by voice. The user is away from the laptop and talks to you through a phone assistant named ${config.assistantName}, who reads your replies aloud.
- Keep your final reply short and speakable: what you did, what you found, what you need. No tables, no long code, no file dumps.
- If you need the user to decide something, end your turn with one clear question. They will answer on the phone.
- Never put secrets, keys or tokens in your reply.
- Your working folder is ${config.workDir}. If it holds several repos, find the right one by name. To work on a repo that is not there yet, clone it into that folder (for example with gh repo clone).`

let notify = () => {}
export function onNotify(fn) { notify = fn }

const state = {
  sessionId: null,
  running: false,
  task: null,
  startedAt: null,
  lastText: '',
  lastResult: '',
  pending: null, // { tool, summary, resolve }
  abort: null,
}

export function status() {
  return {
    running: state.running,
    task: state.task,
    minutesRunning: state.startedAt ? Math.round((Date.now() - state.startedAt) / 60000) : 0,
    latestUpdate: clip(state.lastText, 600),
    lastResult: clip(state.lastResult, 1500),
    waitingForPermission: state.pending ? state.pending.summary : null,
    workDir: config.workDir,
  }
}

export function hasPendingPermission() { return !!state.pending }

export function ask(message) {
  if (state.running) return { ok: false, reason: 'Claude is still working on the last task. Stop it first or wait.' }
  run(message)
  return { ok: true }
}

export function newSession() {
  if (state.running) return { ok: false, reason: 'Claude is still working. Stop it first.' }
  state.sessionId = null
  state.lastResult = ''
  return { ok: true }
}

export function stop() {
  if (!state.running) return { ok: false, reason: 'Nothing is running.' }
  state.abort?.abort()
  if (state.pending) answerPermission(false, 'The user stopped the task.')
  return { ok: true }
}

export function answerPermission(approve, note) {
  const p = state.pending
  if (!p) return { ok: false, reason: 'No permission request is waiting.' }
  state.pending = null
  p.resolve(approve
    ? { behavior: 'allow', updatedInput: p.input }
    : { behavior: 'deny', message: note || 'The user said no.' })
  log(`permission ${approve ? 'approved' : 'denied'}: ${p.tool}`)
  return { ok: true }
}

async function canUseTool(toolName, input, { signal }) {
  const summary = describe(toolName, input)
  log(`permission asked: ${summary}`)
  return new Promise(resolve => {
    state.pending = { tool: toolName, input, summary, resolve }
    signal?.addEventListener('abort', () => {
      if (state.pending?.resolve === resolve) state.pending = null
      resolve({ behavior: 'deny', message: 'Aborted.' })
    })
    notify({ kind: 'permission', text: `Claude is asking permission: ${summary}` })
  })
}

async function run(message) {
  state.running = true
  state.task = clip(message, 300)
  state.startedAt = Date.now()
  state.lastText = ''
  state.abort = new AbortController()
  log(`task started: ${state.task}`)

  let result = ''
  let failed = null
  try {
    const q = query({
      prompt: message,
      options: {
        cwd: config.workDir,
        additionalDirectories: config.extraDirs,
        resume: state.sessionId || undefined,
        permissionMode: config.permissionMode,
        allowedTools: config.allowedTools,
        disallowedTools: ['AskUserQuestion'],
        appendSystemPrompt: VOICE_NOTE,
        canUseTool,
        abortController: state.abort,
      },
    })
    for await (const msg of q) {
      if (msg.session_id) state.sessionId = msg.session_id
      if (msg.type === 'assistant') {
        const text = (msg.message?.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim()
        if (text) state.lastText = text
      } else if (msg.type === 'result') {
        if (msg.subtype === 'success' && !msg.is_error) result = msg.result || state.lastText
        else failed = msg.result || msg.subtype
      }
    }
  } catch (err) {
    failed = state.abort.signal.aborted ? 'stopped by the user' : String(err?.message || err)
  }

  state.running = false
  state.pending = null
  state.startedAt = null
  if (failed) {
    state.lastResult = `The task ended early: ${failed}`
    log(`task failed: ${failed}`)
    notify({ kind: 'failed', text: `Claude's task "${state.task}" ended early: ${clip(String(failed), 500)}` })
  } else {
    state.lastResult = result
    log('task done')
    notify({ kind: 'done', text: `Claude finished "${state.task}". Its reply: ${clip(result, 3000)}` })
  }
}

function describe(tool, input) {
  if (input.command) return `run the command: ${clip(String(input.command), 300)}`
  if (input.file_path) return `use ${tool} on ${input.file_path}`
  if (input.url) return `use ${tool} on ${input.url}`
  return `use ${tool} with ${clip(JSON.stringify(input), 300)}`
}

function clip(s, n) {
  s = String(s || '')
  return s.length > n ? s.slice(0, n) + '...' : s
}
