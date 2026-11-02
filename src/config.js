import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { homedir } from 'node:os'

if (existsSync('.env')) process.loadEnvFile('.env')

const env = (name, fallback) => {
  const v = process.env[name]
  return v === undefined || v === '' ? fallback : v
}

const required = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_NUMBER',
  'MY_NUMBER',
  'OPENAI_API_KEY',
]

// Anton needs the phone settings, the porch settings, or both.
export function checkConfig() {
  const missing = required.filter(k => !env(k))
  const phone = missing.length === 0
  const hub = !!(env('PORCH_URL') && env('PORCH_TOKEN'))
  if (!phone && !hub) {
    console.error(`Missing in .env: ${missing.join(', ')}. Copy .env.example to .env and fill it in, or set PORCH_URL and PORCH_TOKEN to use Anton through a porch hub without a phone.`)
    process.exit(1)
  }
  if (!phone) console.log(`No phone yet (missing ${missing.join(', ')}). Anton works through porch only.`)
  return { phone, hub }
}

const expandHome = p => (p.startsWith('~') ? p.replace('~', homedir()) : p)

export const config = {
  assistantName: env('ASSISTANT_NAME', 'Anton'),
  userName: env('USER_NAME', 'there'),

  twilioSid: env('TWILIO_ACCOUNT_SID'),
  twilioToken: env('TWILIO_AUTH_TOKEN'),
  twilioNumber: env('TWILIO_NUMBER'),
  myNumber: env('MY_NUMBER'),

  openaiKey: env('OPENAI_API_KEY'),
  realtimeModel: env('REALTIME_MODEL', 'gpt-realtime-2.1'),
  voice: env('VOICE', 'cedar'),
  transcribeModel: env('TRANSCRIBE_MODEL', 'gpt-4o-mini-transcribe'),
  // realtime: gpt-realtime over the Twilio media stream (default).
  // live: GPT-Live, OpenAI's full-duplex model, over the same media stream.
  // Calls that reach OpenAI over SIP always use GPT-Live (see src/sip.js).
  voiceEngine: env('VOICE_ENGINE', 'realtime'),
  liveModel: env('LIVE_MODEL', 'gpt-live-1'),
  liveVoice: env('LIVE_VOICE', 'cedar'),
  liveBackendModel: env('LIVE_BACKEND_MODEL', 'gpt-5.5'),
  liveUrl: env('LIVE_URL', 'https://api.openai.com/v1/live/sessions').replace(/\/$/, ''),
  openaiWebhookSecret: env('OPENAI_WEBHOOK_SECRET'),

  workDir: resolve(expandHome(env('WORK_DIR', process.cwd()))),
  extraDirs: env('EXTRA_DIRS', '').split(/[;,]/).map(s => s.trim()).filter(Boolean).map(p => resolve(expandHome(p))),
  permissionMode: env('PERMISSION_MODE', 'acceptEdits'),
  allowedTools: env('ALLOWED_TOOLS', '').split(/[ ,]+/).filter(Boolean),

  port: Number(env('PORT', 8787)),
  publicUrl: env('PUBLIC_URL', '').replace(/\/$/, ''),
  setWebhook: env('SET_WEBHOOK', 'true') !== 'false',

  retryMinutes: Number(env('RETRY_MINUTES', 15)),
  maxAttempts: Number(env('MAX_ATTEMPTS', 0)),
  quietHours: env('QUIET_HOURS', ''),

  antonHome: resolve(expandHome(env('ANTON_HOME', '~/.anton'))),
  maxRunning: Number(env('MAX_RUNNING', 3)),
  memoryModel: env('MEMORY_MODEL', 'haiku'),
  // Least hours between reflections when something new was learned. 0 turns reflection off.
  reflectHours: Number(env('REFLECT_HOURS', 6)),

  porchUrl: env('PORCH_URL', '').replace(/\/$/, ''),
  porchToken: env('PORCH_TOKEN'),
  porchBoss: env('PORCH_BOSS', 'me'),
  porchRoom: env('PORCH_ROOM', 'anton'),
  porchCallOn: env('PORCH_CALL_ON', 'for-me,urgent').split(/[ ,]+/).filter(Boolean),
  porchCallsPerDay: Number(env('PORCH_CALLS_PER_DAY', 4)),
  // Room where Anton shares what you are working on with your other agents. none turns it off.
  porchContextRoom: env('PORCH_CONTEXT_ROOM', 'context').replace(/^none$/i, ''),
}
