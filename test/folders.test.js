import './setup.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A layout like the owner's: <root>/source/repos/{anton}, WORK_DIR = repos.
const root = mkdtempSync(join(tmpdir(), 'anton-folders-'))
const repos = join(root, 'source', 'repos')
mkdirSync(join(repos, 'anton'), { recursive: true })
process.env.WORK_DIR = repos
const agent = await import('../src/agent.js')

test('folders are found the way people say them', () => {
  assert.equal(agent.folderFor('source'), repos, 'the folder WORK_DIR sits in means WORK_DIR')
  assert.equal(agent.folderFor('source folder'), repos, '"folder" at the end is dropped')
  assert.equal(agent.folderFor('repos'), repos)
  assert.equal(agent.folderFor('anton'), join(repos, 'anton'), 'a repo inside WORK_DIR')
  assert.equal(agent.folderFor(join(root, 'source')), join(root, 'source'), 'a full path is taken as said')
})

test('an unknown name is not made into an empty folder unless asked', () => {
  assert.equal(agent.folderFor('nowhere'), null)
  assert.equal(existsSync(join(repos, 'nowhere')), false)
  assert.equal(agent.folderFor('nowhere', { create: true }), join(repos, 'nowhere'))
  assert.equal(existsSync(join(repos, 'nowhere')), true)
})

test('create_session in "source" works there, and a bad folder gets a plain answer', () => {
  const ok = agent.createSession({ name: 'scratch', purpose: 'test', folder: 'source' })
  assert.equal(ok.folder, repos)
  const bad = agent.createSession({ name: 'scratch2', purpose: 'test', folder: 'nowhere-else' })
  assert.equal(bad.ok, false)
  assert.match(bad.reason, /No folder called nowhere-else/)
})
