// Does Alfredo actually run on this machine?
//
// Starts the built server against a throwaway home directory, then makes a
// workspace, writes to it and reads it back. That exercises the parts that
// differ between operating systems: the local Postgres (PGlite, WebAssembly),
// the file the secrets fall back to when there is no keychain, the recorder
// saying what it can do here, and the MCP endpoint. Used by CI on macOS,
// Windows and Linux, and worth running by hand after a change to any of that.

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = Number(process.env.SMOKE_PORT ?? 29987)
const BASE = `http://127.0.0.1:${PORT}`
const home = mkdtempSync(join(tmpdir(), 'alfredo-smoke-'))

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
  if (!ok) failed++
}

const server = spawn(process.execPath, ['dist-server/index.mjs'], {
  env: { ...process.env, ALFREDO_HOME: home, CRM_PORT: String(PORT), NODE_ENV: 'test' },
  stdio: 'inherit',
})
server.on('error', (e) => {
  console.error('could not start the server:', e.message)
  process.exit(1)
})

const json = async (path, init) => {
  const r = await fetch(BASE + path, init)
  return { status: r.status, body: await r.json().catch(() => null) }
}

async function waitForIt() {
  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch(`${BASE}/api/workspaces`)
      if (r.ok) return true
    } catch {}
    await new Promise((r) => setTimeout(r, 1000))
  }
  return false
}

try {
  check('the server starts', await waitForIt())
  if (failed) throw new Error('no server')

  const made = await json('/api/workspaces', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Smoke' }),
  })
  check('a workspace can be made', made.status === 200 && !!made.body?.id, made.body?.id ?? '')
  const ws = made.body?.id
  const as = { 'x-workspace': ws, 'content-type': 'application/json' }

  // The local database is Postgres compiled to WebAssembly; this is the part
  // most likely to differ between platforms, so it is written to and read back.
  const doc = await json('/api/v2/docs', { method: 'POST', headers: as, body: JSON.stringify({ title: 'Hello' }) })
  check('a doc can be written', doc.status === 200 && !!doc.body?.id)
  const saved = await json(`/api/v2/docs/${doc.body?.id}`, {
    method: 'PUT',
    headers: as,
    body: JSON.stringify({ title: 'Hello', body: '# Hello\n\nFrom the smoke test.', revision: doc.body?.revision ?? 0 }),
  })
  check('and saved', saved.status === 200)
  const back = await json('/api/v2/docs', { headers: as })
  check('and read back', back.status === 200 && back.body?.some((d) => d.title === 'Hello'))

  const card = await json('/api/v2/cards', { method: 'POST', headers: as, body: JSON.stringify({ title: 'A card', status: 'todo' }) })
  check('a card can be made', card.status === 200)
  const meeting = await json('/api/v2/meetings', { method: 'POST', headers: as, body: JSON.stringify({ title: 'By hand', notes: 'No recorder needed.' }) })
  check('a meeting can be written by hand', meeting.status === 200)

  // The brain: the embedding model is a native runtime with a build per
  // platform, so this is the part that proves it on the machine running it.
  const read = await json('/api/v2/brain/read', { method: 'POST', headers: as, body: '{}' })
  check('the workspace can be read in', read.status === 200)
  let brain = null
  for (let i = 0; i < 180; i++) {
    brain = (await json('/api/v2/brain', { headers: as })).body
    if (brain?.chunks > 0 || brain?.progress?.state === 'failed' || brain?.state === 'failed') break
    await new Promise((r) => setTimeout(r, 1000))
  }
  check('the embedding model runs here', brain?.chunks > 0, brain?.error ?? brain?.progress?.error ?? `${brain?.chunks ?? 0} passages, model ${brain?.model}`)
  const passages = await json('/api/v2/ask/passages', {
    method: 'POST',
    headers: as,
    body: JSON.stringify({ question: 'what did the smoke test write down?' }),
  })
  check('a question finds its passage', passages.status === 200 && (passages.body?.length ?? passages.body?.passages?.length ?? 0) > 0)

  const engine = await json('/api/v2/transcribe/engine', { headers: as })
  const canRecord = engine.body?.canRecord
  check('the recorder says what it can do here', typeof canRecord === 'boolean', `canRecord=${canRecord}, hears "${engine.body?.hears?.why ?? ''}"`)
  // Every platform can transcribe locally now: CoreML on Apple silicon, ONNX
  // Runtime elsewhere. Which engine is live depends on what has been
  // downloaded, and null means the app should be offering that download.
  check('transcribing here is possible on this platform', engine.body?.localTranscription === true)
  check('the engine says which road it takes', [null, 'fluidaudio', 'onnx'].includes(engine.body?.engine ?? null), `engine=${engine.body?.engine ?? 'none downloaded yet'}`)

  const mcp = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-workspace': ws },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
  const tools = await mcp.text()
  check('the MCP server lists its tools', mcp.ok && tools.includes('ask_workspace'))

  const settings = await json('/api/v2/settings', { headers: as })
  check('the workspace is still there at the end', settings.status === 200 && Array.isArray(settings.body?.tabs))
} catch (e) {
  check(`unexpected: ${e.message}`, false)
} finally {
  server.kill()
  rmSync(home, { recursive: true, force: true })
  console.log(failed ? `\n${failed} check(s) failed on ${process.platform}` : `\nall checks passed on ${process.platform}`)
  process.exit(failed ? 1 : 0)
}
