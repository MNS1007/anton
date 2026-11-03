// Which Claude runner the rest of Anton talks to. By default agent.js, in this
// process. The worker swaps in its own runner (backed by work.db), and the front
// swaps in worker-client.js when WORKER=on. Modules import `agent` from here, so
// one swap reaches all of them. Only entry points call use().
import * as local from './agent.js'

export let agent = local
// worker-client.js in the front with WORKER=on; it also carries longrun and agents.
export let remote = null

export function use(impl, { isRemote = false } = {}) {
  agent = impl
  remote = isRemote ? impl : null
}
