// Claude Code hook: tells Anton when any Claude Code session on this laptop
// finishes a long piece of work or needs your permission, so Anton can call you.
// Add it as a Stop and a Notification hook (see the README). It never blocks Claude.
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

const port = process.env.ANTON_PORT || 8787
const minMinutes = Number(process.env.ANTON_HOOK_MIN_MINUTES || 3)

// Anton's own Claude sessions report to Anton directly.
if (process.env.ANTON_CHILD) process.exit(0)

let input = {}
try { input = JSON.parse(readFileSync(0, 'utf8') || '{}') } catch {}
const where = basename(input.cwd || process.cwd())

let message = null
if (input.hook_event_name === 'Notification') {
  const text = String(input.message || '')
  if (input.notification_type === 'permission_prompt' || /permission/i.test(text)) {
    message = `Claude Code in ${where} needs you: ${text}`
  }
} else if (input.hook_event_name === 'Stop' && !input.stop_hook_active) {
  const turn = readTurn(input.transcript_path)
  const minutes = turn.startedAt ? (Date.now() - turn.startedAt) / 60000 : 0
  // Short replies are you chatting at the desk; only long work is worth a call.
  if (minutes >= minMinutes) {
    const reply = clip(input.last_assistant_message || turn.lastText, 600)
    message = `Claude Code in ${where} finished after ${Math.round(minutes)} min.${reply ? ` It said: ${reply}` : ''}`
  }
}

if (message) {
  try {
    await fetch(`http://127.0.0.1:${port}/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
      signal: AbortSignal.timeout(3000),
    })
  } catch {} // Anton not running: nothing to do
}
process.exit(0)

// When the current turn started (your last typed prompt) and Claude's last words.
function readTurn(path) {
  let startedAt = 0
  let lastText = ''
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line) continue
      let e
      try { e = JSON.parse(line) } catch { continue }
      const content = e.message?.content
      if (e.type === 'user' && !e.isMeta && (typeof content === 'string' || content?.some?.(b => b.type === 'text'))) {
        startedAt = Date.parse(e.timestamp) || startedAt
      } else if (e.type === 'assistant' && Array.isArray(content)) {
        const text = content.filter(b => b.type === 'text').map(b => b.text).join(' ').trim()
        if (text) lastText = text
      }
    }
  } catch {}
  return { startedAt, lastText }
}

function clip(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, n) + '...' : s
}
