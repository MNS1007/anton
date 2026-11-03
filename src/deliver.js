// What to do with a finished task's result, as plain JSON instead of a callback,
// so the worker can still carry it out after a restart. Each module owns its kinds:
//   porch-reply, liaison, liaison-answer, ask-chain, ask-chain-answer  hub.js
//   longrun                                                             longrun.js
//   notify (the default: tell the phone and porch)                      agent.js / worker.js
import * as hub from './hub.js'
import * as longrun from './longrun.js'

// Kinds whose effects stay in work.db, so the worker runs them in one transaction.
export const LOCAL = new Set(['notify', 'longrun'])

export function run(target, result, failed) {
  if (target?.type === 'longrun') return longrun.deliver(target, result, failed)
  if (hub.delivers(target?.type)) return hub.deliver(target, result, failed)
  throw new Error(`unknown delivery ${target?.type}`)
}
