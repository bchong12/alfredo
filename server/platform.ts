// What differs between a Mac, a PC and a Linux box, in one place.
//
// Almost none of Alfredo cares: the server is Node, the local database is
// WebAssembly, the embedding model has a build for each. What does care is
// anything that reaches outside the process, which is three things: finding
// ffmpeg, asking the operating system for a microphone, and running a command
// the way a terminal would so that `claude` and `ffmpeg` are on PATH.

import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const MAC = process.platform === 'darwin'
export const WINDOWS = process.platform === 'win32'
export const LINUX = process.platform === 'linux'

/** Where people's package managers put ffmpeg, then whatever is on PATH. */
const FFMPEG_AT = WINDOWS
  ? [
      'C:\\ffmpeg\\bin\\ffmpeg.exe',
      join(process.env.LOCALAPPDATA ?? '', 'Microsoft\\WinGet\\Links\\ffmpeg.exe'),
      join(process.env.ProgramFiles ?? '', 'ffmpeg\\bin\\ffmpeg.exe'),
      join(process.env.ChocolateyInstall ?? 'C:\\ProgramData\\chocolatey', 'bin\\ffmpeg.exe'),
    ]
  : ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg', '/snap/bin/ffmpeg']

export const ffmpegPath = () => FFMPEG_AT.filter(Boolean).find(existsSync) ?? (WINDOWS ? 'ffmpeg.exe' : 'ffmpeg')

/**
 * How this operating system hands over a microphone.
 *
 * macOS records both sides of a call through the ScreenCaptureKit helper; this
 * is the fallback, and what Windows and Linux use for everything. DirectShow
 * wants the device by name, ALSA/PulseAudio take a default source, and
 * avfoundation takes an index.
 */
export const audioFormat = () => (MAC ? 'avfoundation' : WINDOWS ? 'dshow' : 'pulse')

/** The default input, when nothing better has been found by name. */
export const defaultInput = () => (MAC ? ':0' : WINDOWS ? 'audio=Microphone' : 'default')

/** The arguments that make ffmpeg list what it could record from. */
export const listArgs = () =>
  MAC
    ? ['-f', 'avfoundation', '-list_devices', 'true', '-i', '']
    : WINDOWS
      ? ['-f', 'dshow', '-list_devices', 'true', '-i', 'dummy']
      : ['-f', 'pulse', '-list_devices', 'true', '-i', 'default']

/**
 * Run a command the way a terminal would.
 *
 * On macOS and Linux that means a login shell, because an app launched from
 * Finder or a dock inherits almost no PATH, and `claude` usually lives
 * somewhere a version manager put it. On Windows PATH is the same everywhere,
 * so the command runs directly through the shell.
 */
export function runAsUser(command: string, opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  if (WINDOWS) return spawn(command, { ...opts, shell: true })
  const shell = process.env.SHELL || '/bin/zsh'
  return spawn(shell, ['-lic', command], opts)
}

/** Is this command on PATH, as a terminal would see it? */
export function onPath(command: string, timeoutMs = 8000): Promise<boolean> {
  return new Promise((resolve) => {
    const done = setTimeout(() => resolve(false), timeoutMs)
    const finish = (yes: boolean) => {
      clearTimeout(done)
      resolve(yes)
    }
    if (WINDOWS) {
      execFile('where', [command], { windowsHide: true }, (err, out) => finish(!err && out.trim().length > 0))
      return
    }
    const p = runAsUser(`command -v ${command}`)
    let out = ''
    p.stdout?.on('data', (d) => (out += d))
    p.on('exit', () => finish(out.trim().length > 0))
    p.on('error', () => finish(false))
  })
}

/** The shell a terminal session should open with. */
export const userShell = () =>
  WINDOWS ? process.env.COMSPEC || 'powershell.exe' : process.env.SHELL || '/bin/zsh'
