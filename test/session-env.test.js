import './setup.js'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

const agent = await import('../src/agent.js')
const { dotenvNames } = await import('../src/config.js')

const PLANTED = 'sk-PLANTED-SECRET-123'
const HANDLE = 'pvh_' + 'h'.repeat(43)

// Anton's own keys and tokens, as its .env would set them, plus one from the shell.
const planted = {
  OPENAI_API_KEY: PLANTED, GEMINI_API_KEY: PLANTED, GOOGLE_API_KEY: PLANTED,
  PORCH_TOKEN: PLANTED, PORCH_URL: 'http://porch.test/' + PLANTED,
  TWILIO_ACCOUNT_SID: PLANTED, TWILIO_AUTH_TOKEN: PLANTED, OPENAI_WEBHOOK_SECRET: PLANTED,
  SOME_SERVICE_API_KEY: PLANTED, DB_PASSWORD: PLANTED,
}
const saved = {}
for (const k of [...Object.keys(planted), 'ANTHROPIC_API_KEY']) saved[k] = process.env[k]
after(() => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v
})

test('a session with no grant inherits none of Anton\'s keys or tokens', () => {
  Object.assign(process.env, planted, { ANTHROPIC_API_KEY: 'claude-own-sign-in' })
  agent.onTaskEnv(() => ({}))
  const env = agent.childEnv('nogrant')
  assert.ok(!JSON.stringify(env).includes(PLANTED), 'a planted value reached the session env')
  for (const k of Object.keys(planted)) assert.equal(env[k], undefined, k)
  for (const k of dotenvNames) {
    if (/^(ANTHROPIC_|CLAUDE_)/i.test(k)) continue
    assert.equal(env[k], undefined, `${k} from Anton's .env reached the session`)
  }
  // What Claude Code needs to run still passes.
  assert.equal(env.ANTHROPIC_API_KEY, 'claude-own-sign-in')
  assert.ok(Object.keys(env).some(k => k.toUpperCase() === 'PATH'))
  assert.equal(env.ANTON_CHILD, '1')
})

test('a granted session gets its handle in place of the key; a read-only task gets none', () => {
  Object.assign(process.env, planted)
  agent.onTaskEnv(name => (name === 'vision' ? { OPENAI_BASE_URL: 'http://127.0.0.1:7778/vault/proxy/openai/v1', OPENAI_API_KEY: HANDLE } : {}))
  const env = agent.childEnv('vision')
  assert.equal(env.OPENAI_API_KEY, HANDLE)
  assert.equal(env.OPENAI_BASE_URL, 'http://127.0.0.1:7778/vault/proxy/openai/v1')
  assert.equal(env.GEMINI_API_KEY, undefined)
  assert.ok(!JSON.stringify(env).includes(PLANTED))
  const ro = agent.childEnv('vision', true)
  assert.equal(ro.OPENAI_API_KEY, undefined)
  assert.ok(!JSON.stringify(ro).includes(PLANTED))
})

test('sessions cannot pick up vault handles over porch MCP', () => {
  assert.ok(agent.SESSION_DENIED.includes('mcp__porch__vault_status'))
  assert.ok(agent.SESSION_DENIED.includes('AskUserQuestion'))
})
