// The worker's API key, in ANTON_HOME/worker.secret, made on first start. Only the
// front and the worker read it. Kept apart from workdb.js so the front never
// loads node:sqlite.
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

export const validSecret = s => /^[0-9a-f]{64}$/.test(String(s || ''))
// null when there is no file yet. A file busy for a moment (Windows) is read again.
const pause = new Int32Array(new SharedArrayBuffer(4))
function read(file) {
  for (let i = 0; ; i++) {
    try { return readFileSync(file, 'utf8').trim() } catch (err) {
      if (err.code === 'ENOENT') return null
      if (i >= 20) throw err
      Atomics.wait(pause, 0, 0, 10)
    }
  }
}

// The file only ever appears complete: the key is written under a temp name and
// then linked into place, which fails if another process got there first (its key
// is used then). An empty or broken file, from a crash mid-write in an older
// version, is replaced. Throws rather than return a key that is not one.
export function workerSecret(home) {
  const file = join(home, 'worker.secret')
  let s = read(file)
  if (validSecret(s)) return s
  mkdirSync(home, { recursive: true })
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, randomBytes(32).toString('hex'), { mode: 0o600 })
  try {
    if (s !== null) renameSync(tmp, file)
    else {
      try { linkSync(tmp, file) } catch (err) {
        // No hard links on this drive: a plain rename, unless someone made it meanwhile.
        if (err.code !== 'EEXIST' && !existsSync(file)) renameSync(tmp, file)
      }
    }
  } finally { rmSync(tmp, { force: true }) }
  s = read(file)
  if (!validSecret(s)) throw new Error('ANTON_HOME/worker.secret could not be made')
  return s
}
