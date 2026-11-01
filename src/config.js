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

export function checkConfig() {
  const missing = required.filter(k => !env(k))
  if (missing.length) {
    console.error(`Missing in .env: ${missing.join(', ')}. Copy .env.example to .env and fill it in.`)
    process.exit(1)
  }
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

  workDir: resolve(expandHome(env('WORK_DIR', process.cwd()))),
  permissionMode: env('PERMISSION_MODE', 'acceptEdits'),
  allowedTools: env('ALLOWED_TOOLS', '').split(/[ ,]+/).filter(Boolean),

  port: Number(env('PORT', 8787)),
  publicUrl: env('PUBLIC_URL', '').replace(/\/$/, ''),
  setWebhook: env('SET_WEBHOOK', 'true') !== 'false',

  retryMinutes: Number(env('RETRY_MINUTES', 15)),
  maxAttempts: Number(env('MAX_ATTEMPTS', 0)),
  quietHours: env('QUIET_HOURS', ''),
}
