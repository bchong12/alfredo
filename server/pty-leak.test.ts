// Terminal sessions must give their pseudo-terminals back.
//
// macOS has 511 pseudo-terminals in all. node-pty 1.1.0 kept two descriptors
// open for every session it ever started, so after a few days the app held
// every one of them and no terminal on the Mac could open (forkpty: Device
// not configured). This opens and closes sessions the way the app does and
// checks the count comes back to where it started.
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { test } from 'node:test'
import { open, close, write, list } from './pty'

const held = () => {
  // Masters show as /dev/ptmx; a slave whose master has gone shows as (revoked).
  const out = execSync(`lsof -p ${process.pid} 2>/dev/null | grep -c "/dev/ptmx\\|(revoked)" || true`).toString().trim()
  return Number(out)
}
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('pseudo-terminals are released when sessions end', { skip: process.platform !== 'darwin' && 'counts /dev/ptmx with lsof, a macOS thing' }, async () => {
  const before = held()
  // Sessions that end on their own.
  for (let i = 0; i < 8; i++) {
    const s = open({ cwd: process.env.HOME ?? '/', kind: 'shell', title: `leak ${i}` })
    // A shell told to exit; the session is closed after it ended.
    write(s.id, 'exit\n')
    for (let t = 0; t < 100 && !list().find((x) => x.id === s.id)?.exitedAt; t++) await settle(50)
    close(s.id)
  }
  // Sessions closed while still running, the way a tab's close button does it.
  for (let i = 0; i < 8; i++) {
    const s = open({ cwd: process.env.HOME ?? '/', kind: 'shell', title: `kill ${i}` })
    await settle(100)
    close(s.id)
  }
  await settle(800)
  assert.equal(held(), before, `${held() - before} pseudo-terminal descriptor(s) left open after 16 sessions`)
})
