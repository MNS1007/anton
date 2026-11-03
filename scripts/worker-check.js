// Prints the worker's metrics and fails if any work was lost or delivered twice.
// Run: npm run worker-check (reads WORKER_PORT and the secret from ANTON_HOME).
import { metrics } from '../src/worker-client.js'

let m
try { m = await metrics() } catch (err) {
  console.error(`The worker is not answering (${err.message}). Start it with npm run worker, or npm start with WORKER=on.`)
  process.exit(2)
}
const t = m.tasks
console.log(`tasks:      ${t.started} started, ${t.done} done, ${t.failed} failed, ${t.stopped} stopped, ${t.running} running, ${t.queued} queued`)
console.log(`restarts:   ${t.interrupted} interrupted, ${t.resumed} resumed, resume latency avg ${m.resumeLatencyMs.avg} ms, max ${m.resumeLatencyMs.max} ms`)
console.log(`long runs:  ${m.runs.active} active, ${m.runs.ended} ended; rounds ${m.rounds.started} started, ${m.rounds.done} done, ${m.rounds.failed} failed`)
console.log(`outbox:     ${m.outbox.waiting} waiting for the front, oldest ${m.outbox.oldestSeconds} s`)
console.log(`delivery:   ${m.undelivered} results not delivered yet`)
console.log(`lost:       ${m.lost}`)
console.log(`duplicates: ${m.duplicates}`)
if (m.lost > 0 || m.duplicates > 0) {
  console.error('FAIL: work was lost or delivered twice.')
  process.exit(1)
}
console.log('ok')
