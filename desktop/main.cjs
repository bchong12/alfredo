// Alfredo as a desktop app: one window around the same UI, with the local
// server started alongside it. In development it loads Vite for hot reload;
// packaged, it serves the built files itself. macOS, Windows and Linux differ
// in two small ways here, both marked WIN below: where PATH comes from, and
// whether closing the last window quits.
const { app, BrowserWindow, shell, nativeTheme, screen, session, desktopCapturer, systemPreferences } = require('electron')
const { spawn } = require('node:child_process')
const { join } = require('node:path')
const { existsSync } = require('node:fs')
const http = require('node:http')

const DEV = !app.isPackaged
// Packaged, the app's files sit under Resources/app (no asar, so node-pty's
// helper and PGlite's wasm are ordinary files on disk).
const ROOT = DEV ? join(__dirname, '..') : join(process.resourcesPath, 'app')
const PORT = Number(process.env.CRM_PORT || 29981)
const UI = DEV ? 'http://localhost:5210' : `http://127.0.0.1:${PORT}`
const { homedir } = require('node:os')
const { chmodSync } = require('node:fs')

let server = null
let win = null

/** Login-shell PATH, so `claude`, `ffmpeg` and node are found inside sessions
 *  the same way they are in Terminal. Finder launches carry almost none. */
function loginEnv() {
  // WIN: a Windows process already inherits the user's PATH, and there is no
  // login shell to ask.
  if (process.platform === 'win32') return strip({ ...process.env })
  try {
    const out = require('node:child_process').execFileSync(process.env.SHELL || '/bin/zsh', ['-lic', 'env'], {
      encoding: 'utf8', timeout: 8000,
    })
    const env = { ...process.env }
    for (const line of out.split('\n')) {
      const i = line.indexOf('=')
      if (i > 0) env[line.slice(0, i)] = line.slice(i + 1)
    }
    return strip(env)
  } catch {
    return strip({ ...process.env })
  }
}

/** Never launch as if inside another Claude Code session. */
function strip(env) {
  for (const k of Object.keys(env)) if (/^(CLAUDE|AI_AGENT)/.test(k)) delete env[k]
  return env
}

/** Secrets live outside the app bundle: ~/.alfredo/.env.local, or the repo's in development. */
function envFile() {
  /* ~/.alfredo, or ~/.alfred from before the rename, whichever holds the keys. */
  const home = [join(homedir(), '.alfredo', '.env.local'), join(homedir(), '.alfred', '.env.local')].find((f) => existsSync(f)) ?? join(homedir(), '.alfredo', '.env.local')
  if (existsSync(home)) return home
  const repo = join(ROOT, '.env.local')
  return existsSync(repo) ? repo : null
}

function up(url) {
  return new Promise((resolve) => {
    const r = http.get(url, (res) => { res.resume(); resolve(res.statusCode < 500) })
    r.on('error', () => resolve(false))
    r.setTimeout(1500, () => { r.destroy(); resolve(false) })
  })
}

async function ensureServer() {
  if (await up(`http://127.0.0.1:${PORT}/api/workspaces`)) return // already running (npm run dev)
  const env = { ...loginEnv(), CRM_PORT: String(PORT), CRM_PUBLIC: '0' }
  if (!DEV) env.ALFRED_DESKTOP = '1'
  const ef = envFile()
  const entry = DEV ? ['--import', 'tsx', join(ROOT, 'server/index.ts')] : [join(ROOT, 'dist-server/index.mjs')]
  const args = [...(ef ? ['--env-file', ef] : []), ...entry]
  // node-pty's spawn helper loses its execute bit in transit; every launch
  // puts it back rather than hoping the install did.
  // Only a POSIX build has a spawn-helper that needs the executable bit.
  for (const arch of process.platform === 'win32' ? [] : ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64']) {
    try {
      chmodSync(join(ROOT, 'node_modules/node-pty/prebuilds', arch, 'spawn-helper'), 0o755)
    } catch {}
  }
  server = spawn(process.execPath, args, { cwd: ROOT, env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit' })
  for (let i = 0; i < 60; i++) {
    if (await up(`http://127.0.0.1:${PORT}/api/workspaces`)) return
    await new Promise((r) => setTimeout(r, 500))
  }
}

async function ensureUi() {
  if (!DEV) return
  if (await up(UI)) return
  const dev = 'npx vite --port 5210'
  if (process.platform === 'win32') spawn(dev, { cwd: ROOT, stdio: 'ignore', shell: true })
  else spawn(process.env.SHELL || '/bin/zsh', ['-lic', dev], { cwd: ROOT, stdio: 'ignore', detached: false })
  for (let i = 0; i < 60; i++) {
    if (await up(UI)) return
    await new Promise((r) => setTimeout(r, 500))
  }
}

function createWindow() {
  // Fill most of the screen it opens on; the columns need the room.
  const area = screen.getPrimaryDisplay().workAreaSize
  win = new BrowserWindow({
    width: Math.min(1680, Math.round(area.width * 0.92)),
    height: Math.min(1100, Math.round(area.height * 0.92)),
    minWidth: 960,
    minHeight: 600,
    title: 'Alfredo',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0d0d0d' : '#ffffff',
    webPreferences: { contextIsolation: true, sandbox: true },
  })
  win.loadURL(UI)
  // Links leave the app; the app is for Alfredo.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' } })
  win.on('closed', () => (win = null))
}

app.whenReady().then(async () => {
  // Every launch is a fresh page: a new build must never load from cache.
  const { session } = require('electron')
  await session.defaultSession.clearCache().catch(() => {})
  await Promise.all([ensureServer(), ensureUi()])
  createWindow()
  app.on('activate', () => {
    if (!win) createWindow()
    else win.show()
  })
})

// Mac convention: closing the window leaves the app (and its sessions)
// running; the Dock icon or ⌘Tab brings the window back.
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', () => { if (server) server.kill() })

// Anything that takes the main process down is worth a line in the log.
process.on('uncaughtException', (e) => console.error('[alfredo] uncaught', e))
process.on('unhandledRejection', (e) => console.error('[alfredo] unhandled', e))
