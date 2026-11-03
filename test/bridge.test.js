import './setup.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { isFiller, isEcho, turnSettings } from '../src/bridge.js'
import { callTrace } from '../src/trace.js'

test('backchannels and noise need no answer', () => {
  for (const t of ['', '.', 'Yeah.', 'ok', 'Mm-hmm', 'mhm', 'Yeah, yeah.', 'Okay okay', 'Got it.', '...', 'Hm.'])
    assert.equal(isFiller(t), true, t)
  for (const t of ['Sorry, sorry, go ahead.', 'Yeah, send it to Muse.', 'What was stuck?', 'Stop.', 'No.'])
    assert.equal(isFiller(t), false, t)
})

test('Anton heard back on the line is echo, the user is not', () => {
  const spoken = 'Hey Nithin. Renfort found why it seemed unreachable: the phone side sent empty tasks.'
  assert.equal(isEcho('Renfort found why it seemed unreachable', spoken), true)
  assert.equal(isEcho('why is it unreachable, can you check muse', spoken), false)
  assert.equal(isEcho('Hey Nithin', spoken), false) // too short to tell
})

test('the server never cuts Anton off or answers by itself; English and noise reduction on', () => {
  const s = turnSettings()
  assert.equal(s.turn_detection.create_response, false)
  assert.equal(s.turn_detection.interrupt_response, false)
  assert.equal(s.turn_detection.type, 'semantic_vad')
  assert.equal(s.transcription.language, 'en')
  assert.deepEqual(s.noise_reduction, { type: 'near_field' })
})

test('the call trace writes timed events', () => {
  const t = callTrace('CAtest')
  t.add('speech.started', { antonTalking: true })
  t.end()
  const lines = readFileSync(t.file, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.equal(lines[0].ev, 'speech.started')
  assert.equal(typeof lines[0].ms, 'number')
})
