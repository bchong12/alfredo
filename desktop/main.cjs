// Alfredo as a desktop app: one window around the same UI, with the local
// server started alongside it. In development it loads Vite for hot reload;
// packaged, it serves the built files itself. macOS, Windows and Linux differ
// in two small ways here, both marked WIN below: where PATH comes from, and
// whether closing the last window quits.
const { app, BrowserWindow, ipcMain, Notification, shell, nativeTheme, screen, session, desktopCapturer, systemPreferences } = require('electron')
const { spawn } = require('node:child_process')
const { join } = require('node:path')
const { existsSync, appendFileSync, mkdirSync, statSync, writeFileSync, readFileSync } = require('node:fs')
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

/** Development has no app bundle to take an icon from, so the dock is told. */
function ownIcon() {
  if (process.platform !== 'darwin' || !app.dock) return
  const png = join(__dirname, 'icon', 'icon.png')
  if (DEV && existsSync(png)) app.dock.setIcon(png)
}

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
  // Where the packaged app keeps what it ships beside the code (the audio helper).
  if (!DEV) env.ALFREDO_RESOURCES = process.resourcesPath
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
  // Everything the server says goes to a file, so a machine where it does
  // not start has something to show (and to send).
  const logs = join(app.getPath('home'), '.alfredo', 'logs')
  try {
    mkdirSync(logs, { recursive: true })
    if (existsSync(SERVER_LOG) && statSync(SERVER_LOG).size > 1_000_000) writeFileSync(SERVER_LOG, '')
  } catch {}
  const log = (line) => { try { appendFileSync(SERVER_LOG, line) } catch {} }
  log(`\n--- ${new Date().toISOString()} Alfredo ${app.getVersion()} on ${process.platform} ${process.arch}, Electron ${process.versions.electron}\n`)
  server = spawn(process.execPath, args, { cwd: ROOT, env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
  server.stdout.on('data', (d) => log(d.toString()))
  server.stderr.on('data', (d) => log(d.toString()))
  server.on('exit', (code, signal) => log(`--- server exited: code ${code} signal ${signal}\n`))
  server.on('error', (e) => log(`--- server could not start: ${e.message}\n`))
  for (let i = 0; i < 60; i++) {
    if (await up(`http://127.0.0.1:${PORT}/api/workspaces`)) return true
    if (server.exitCode !== null) break
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}
const SERVER_LOG = join(app.getPath('home'), '.alfredo', 'logs', 'server.log')

/** What the window shows when the server did not come up: the log, and a way to copy it. */
function couldNotStart() {
  let tail = ''
  try { tail = readFileSync(SERVER_LOG, 'utf8').split('\n').slice(-60).join('\n') } catch {}
  const esc = (t) => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
  const html = `<!doctype html><meta charset="utf-8"><title>Alfredo</title>
<style>body{margin:0;background:#0d0d0d;color:#ededed;font:14px/1.5 -apple-system,Segoe UI,system-ui,sans-serif}.w{max-width:760px;margin:80px auto;padding:0 24px}h1{font-size:20px;font-weight:600;margin:0 0 8px}p{color:#a1a1a1;margin:0 0 18px}pre{background:#0a0a0a;border:1px solid #262626;border-radius:8px;padding:14px;font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;max-height:50vh;overflow:auto;color:#a1a1a1}button{margin:14px 8px 0 0;height:32px;padding:0 14px;border-radius:7px;border:1px solid #262626;background:#171717;color:#ededed;font:inherit;cursor:pointer}button.p{background:#ededed;color:#0d0d0d;border-color:#ededed}code{font-family:ui-monospace,Menlo,Consolas,monospace;color:#ededed}</style>
<div class="w"><h1>Alfredo's server did not start</h1><p>The app runs a small server on this machine and it did not come up. Below is what it said. Copy it and send it to whoever runs your workspace; it is also at <code>${esc(SERVER_LOG)}</code>.</p><pre id="l">${esc(tail || '(nothing was written)')}</pre><button class="p" onclick="location.reload()">Try again</button><button onclick="navigator.clipboard.writeText(document.getElementById('l').innerText)">Copy the log</button></div>`
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html)
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
    // Windows and Linux take the icon from the window; macOS takes it from
    // the bundle, and from the dock in development (see below).
    ...(process.platform === 'darwin' ? {} : { icon: join(__dirname, 'icon', 'icon.png') }),
    // The version rides along for the page to show (a sandboxed preload sees argv, not env).
    webPreferences: { contextIsolation: true, sandbox: true, preload: join(__dirname, 'preload.cjs'), additionalArguments: [`--alfredo-version=${app.getVersion()}`] },
  })
  win.loadURL(UI)
  // Links leave the app; the app is for Alfredo.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' } })
  win.on('closed', () => (win = null))
}

/*
 * Updates, over the air. A packaged app asks the GitHub release page for a
 * newer version on launch and every few hours, downloads it in the
 * background, and tells the page; the page offers one button, and the app
 * quits, installs and comes back. Nothing installs on its own: someone may
 * be mid-recording. (Needs a signed build; unsigned ones cannot be replaced.)
 */
function setupUpdates() {
  if (DEV || !app.isPackaged) return
  let autoUpdater
  try {
    ;({ autoUpdater } = require('electron-updater'))
  } catch {
    return
  }
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  const tell = (state, more = {}) => win?.webContents.send('update-state', { state, at: Date.now(), ...more })
  autoUpdater.on('checking-for-update', () => tell('checking'))
  autoUpdater.on('update-not-available', (info) => tell('latest', { latest: info?.version ?? null }))
  autoUpdater.on('update-available', (info) => tell('downloading', { version: info.version, notes: typeof info.releaseNotes === 'string' ? info.releaseNotes : '' }))
  autoUpdater.on('download-progress', (p) => tell('downloading', { percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (info) => {
    tell('ready', { version: info.version, notes: typeof info.releaseNotes === 'string' ? info.releaseNotes : '' })
    win?.webContents.send('update-ready', { version: info.version })
  })
  autoUpdater.on('error', (e) => {
    const msg = String(e?.message ?? e)
    console.error(`[update] ${msg}`)
    // No app-update.yml: a build made by hand (npm run desktop:install), not from a release.
    if (/app-update\.yml/.test(msg)) return tell('unmanaged')
    tell('error', { error: msg })
  })
  ipcMain.on('install-update', () => autoUpdater.quitAndInstall())
  ipcMain.handle('check-update', async () => {
    try {
      const r = await autoUpdater.checkForUpdates()
      return { version: r?.updateInfo?.version ?? null }
    } catch (e) {
      return { error: e?.message ?? String(e) }
    }
  })
  // Soon after launch, every half hour, and whenever the window comes back
  // to the front (no oftener than every ten minutes): a new version should
  // reach people within the hour, not by tomorrow.
  let lookedAt = 0
  const look = () => {
    lookedAt = Date.now()
    autoUpdater.checkForUpdates().catch(() => {})
  }
  setTimeout(look, 15_000)
  setInterval(look, 30 * 60_000)
  app.on('browser-window-focus', () => {
    if (Date.now() - lookedAt > 10 * 60_000) look()
  })
}

/*
 * System notifications, for the page: a meeting the machine can see going
 * on, or one that seems to have ended. One button each; pressing it, or the
 * notification itself, brings the window up and tells the page which.
 */
ipcMain.on('notify', (_e, n) => {
  if (!Notification.isSupported()) return
  const note = new Notification({
    title: n.title,
    body: n.body ?? '',
    silent: !!n.silent,
    ...(n.action && process.platform === 'darwin' ? { actions: [{ type: 'button', text: n.action }], closeButtonText: 'Not now' } : {}),
  })
  const tell = (action) => {
    if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus() }
    win?.webContents.send('notify-action', { id: n.id, action })
  }
  note.on('action', () => tell(n.action))
  note.on('click', () => tell(process.platform === 'darwin' ? 'open' : n.action ?? 'open'))
  note.show()
})

app.whenReady().then(async () => {
  ownIcon()
  setupUpdates()
  // Every launch is a fresh page: a new build must never load from cache.
  const { session } = require('electron')
  await session.defaultSession.clearCache().catch(() => {})
  const [serverUp] = await Promise.all([ensureServer(), ensureUi()])
  createWindow()
  // No server, no app: say so, with the log, instead of a page that cannot load.
  if (serverUp === false) win?.loadURL(couldNotStart())
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
