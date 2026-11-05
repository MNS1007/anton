import './setup.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as caller from '../src/caller.js'
import { callTools, TOOLS, instructions } from '../src/tools.js'

caller.setDialer(() => {})

test('dont_call is a tool, and only the user can use it (an update alone cannot)', async () => {
  assert.ok(TOOLS.some(t => (t.name || t.function?.name) === 'dont_call'))
  const tools = callTools()
  tools.outside() // an update or agent post arrived; the user has not spoken since
  const blocked = await tools.run('dont_call', { minutes: 0 })
  assert.equal(blocked.ok, false)
  tools.userSpoke()
  const r = await tools.run('dont_call', { minutes: 45, reason: 'at dinner' })
  assert.equal(r.ok, true)
  assert.ok(caller.dontCallUntil())
  assert.equal((await tools.run('dont_call', { minutes: 0 })).ok, true)
  assert.equal(caller.dontCallUntil(), null)
})

test('the call prompt tells the model the delay is enforced', () => {
  assert.match(instructions([]), /dont_call/)
})
