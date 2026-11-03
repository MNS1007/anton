// A per-call event trace in ANTON_HOME/traces, one JSON line per event with the
// milliseconds since the call started. The transcript keeps what was said; the
// trace keeps when speech started and stopped, what was cut off and why, and how
// late Node was (event loop lag), so a bad call can be replayed step by step.
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { config } from './config.js'

export function callTrace(callSid, { dir = join(config.antonHome, 'traces'), lagEveryMs = 5000 } = {}) {
  const t0 = Date.now()
  const file = join(dir, `${new Date().toISOString().slice(0, 10)}_${callSid || 'call'}.jsonl`)
  try { mkdirSync(dir, { recursive: true }) } catch {}
  const write = obj => { try { appendFileSync(file, JSON.stringify(obj) + '\n') } catch {} }

  // Lag above 100 ms means audio and events were handled late, as under CPU load.
  const lag = monitorEventLoopDelay({ resolution: 20 })
  lag.enable()
  const timer = setInterval(() => {
    const max = Math.round(lag.max / 1e6)
    if (max >= 100) write({ ms: Date.now() - t0, ev: 'lag', maxMs: max, meanMs: Math.round(lag.mean / 1e6) })
    lag.reset()
  }, lagEveryMs)
  timer.unref?.()

  return {
    file,
    add(ev, data = {}) { write({ ms: Date.now() - t0, ev, ...data }) },
    end() { clearInterval(timer); lag.disable() },
  }
}
