// Recording.
//
// Two backends. The native one is a small ScreenCaptureKit helper
// (native/alfredo-audio) that writes system audio and the microphone to two
// wav files with no driver installed: it hears both sides of a call the way
// the OS itself would. When that helper is not built, ffmpeg records the
// microphone alone from an avfoundation device, which is what this file did
// before. Off a Mac there is no helper, so it is always the microphone:
// DirectShow on Windows, PulseAudio on Linux, chosen in platform.ts. Either
// way the result is one 16 kHz mono wav for the transcriber.

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, statSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { appHome, audioHelper } from './home'
import { MAC, WINDOWS, audioFormat, defaultInput, ffmpegPath, listArgs } from './platform'

const DIR = resolve(process.env.CRM_RECORDINGS_DIR ?? join(appHome(), 'recordings'))
const DEVICE = process.env.CRM_AUDIO_DEVICE ?? '1'
const HELPER = audioHelper()
const FFMPEG = ffmpegPath()

export type Recording = {
  id: string
  path: string
  startedAt: number
  proc: ChildProcess
  /** 'native' hears system audio and the mic; 'mic' is ffmpeg on the microphone. */
  backend: 'native' | 'mic'
  /** Set once the helper reports whether system audio came up. */
  systemAudio: boolean | null
  dir: string
}

/** Only one recording at a time: two captures on one device fail quietly. */
let current: Recording | null = null

export const isRecording = () => current !== null
export const nativeAvailable = () => existsSync(HELPER)
/** Call once at boot so the first recording does not wait on a device scan. */
export const prepare = () => resolveMic().catch(() => {})
export function currentRecording() {
  return current && { id: current.id, path: current.path, startedAt: current.startedAt, backend: current.backend, systemAudio: current.systemAudio }
}

export function listDevices(): Promise<string> {
  return new Promise((res) => {
    const p = spawn(FFMPEG, listArgs())
    let out = ''
    p.stderr.on('data', (d) => (out += d))
    p.on('close', () => res(out))
    // No ffmpeg on this machine is an ordinary state, not a reason to bring
    // the server down: everything except recording still works.
    p.on('error', () => res(''))
  })
}

/** Is there an ffmpeg to record with at all? */
export const ffmpegAvailable = () => !WINDOWS ? existsSync(FFMPEG) || FFMPEG === 'ffmpeg' : true

/**
 * Which avfoundation input is the microphone. Device indexes move as virtual
 * devices (Teams, Zoom) come and go, so a number in .env.local goes stale;
 * the name does not. Resolved once, lazily.
 */
let micInput = process.env.CRM_AUDIO_DEVICE ? (MAC ? `:${DEVICE}` : DEVICE) : defaultInput()
let resolvedMic = false
async function resolveMic() {
  if (resolvedMic) return
  resolvedMic = true
  if (process.env.CRM_AUDIO_DEVICE) return
  const out = await listDevices().catch(() => '')
  if (WINDOWS) {
    // DirectShow prints every device as "Name" (audio) on its own line, and
    // wants that name back, not an index.
    const names = [...out.matchAll(/"([^"]+)"\s*\(audio\)/g)].map((m) => m[1])
    const mic = names.find((n) => /microphone|mic\b|input|array/i.test(n)) ?? names[0]
    if (mic) micInput = `audio=${mic}`
    return
  }
  if (!MAC) return // PulseAudio's default source is the right answer on Linux
  const audio = out.split('\n').filter((l) => /\[\d+\] /.test(l) && !/video/i.test(l))
  const rows = audio.slice(audio.findIndex((l) => /audio devices/i.test(l)) + 1)
  const parsed = rows.map((l) => /\[(\d+)\] (.*)$/.exec(l)).filter(Boolean).map((m) => ({ idx: m![1], name: m![2] }))
  const byEnv = parsed.find((d) => d.idx === DEVICE)
  if (byEnv && /mic/i.test(byEnv.name)) return
  const mic = parsed.find((d) => /microphone|built-in|mic\b/i.test(d.name))
  if (mic) micInput = `:${mic.idx}`
}

export function start(id: string, micOnly = false) {
  if (current) throw new Error(`already recording (${current.id}) — stop it first`)
  mkdirSync(DIR, { recursive: true })
  const path = resolve(DIR, `${id}.wav`)

  if (nativeAvailable()) {
    const dir = resolve(DIR, id)
    mkdirSync(dir, { recursive: true })
    const proc = spawn(HELPER, micOnly ? ['record', dir, '--mic-only'] : ['record', dir], { stdio: ['ignore', 'pipe', 'pipe'] })
    const rec: Recording = { id, path, startedAt: Date.now(), proc, backend: 'native', systemAudio: null, dir }
    proc.stdout!.on('data', (d) => {
      const s = d.toString()
      if (s.includes('recording')) rec.systemAudio = true
      if (s.includes('mic-only')) rec.systemAudio = false
    })
    let err = ''
    proc.stderr!.on('data', (d) => (err += d))
    proc.on('error', (e) => {
      console.error(`[audio] could not start the recorder: ${(e as Error).message}`)
      if (current?.id === id) current = null
    })
    proc.on('close', (code) => {
      if (code && err.trim()) console.error(`[audio] alfredo-audio exited ${code}: ${err.trim().slice(-400)}`)
      if (current?.id === id) current = null
    })
    current = rec
    return rec
  }

  const proc = spawn(FFMPEG, [
    '-hide_banner', '-loglevel', 'error',
    '-f', audioFormat(), '-i', micInput,
    '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-y', path,
  ])
  let stderr = ''
  proc.stderr.on('data', (d) => (stderr += d))
  proc.on('error', (e) => {
    console.error(`[audio] could not start ${FFMPEG}: ${(e as Error).message}`)
    if (current?.id === id) current = null
  })
  proc.on('close', (code) => {
    if (code !== 0 && code !== 255 && stderr.trim()) console.error(`[audio] ffmpeg exited ${code}: ${stderr.trim()}`)
    if (current?.id === id) current = null
  })
  current = { id, path, startedAt: Date.now(), proc, backend: 'mic', systemAudio: false, dir: DIR }
  return current
}

/** Mix system and mic into one mono wav. Either track may be silent or missing. */
function mix(dir: string, out: string): Promise<void> {
  const sys = join(dir, 'system.wav')
  const mic = join(dir, 'mic.wav')
  const has = (p: string) => existsSync(p) && statSync(p).size > 1024
  return new Promise((res, reject) => {
    let args: string[]
    if (has(sys) && has(mic)) {
      args = ['-i', mic, '-i', sys, '-filter_complex', '[0:a][1:a]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.95', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-y', out]
    } else if (has(mic) || has(sys)) {
      args = ['-i', has(mic) ? mic : sys, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-y', out]
    } else return reject(new Error('recording captured nothing. Check Microphone and Screen Recording permissions for Alfredo in System Settings > Privacy & Security.'))
    const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', ...args])
    let err = ''
    p.stderr.on('data', (d) => (err += d))
    p.on('close', (c) => (c === 0 ? res() : reject(new Error(`ffmpeg mix failed: ${err}`))))
  })
}

export function stop(): Promise<{ id: string; path: string; durationS: number; bytes: number; systemAudio: boolean | null }> {
  const rec = current
  if (!rec) throw new Error('not recording')
  return new Promise((res, reject) => {
    let settled = false
    const done = async () => {
      if (settled) return
      settled = true
      current = null
      try {
        if (rec.backend === 'native') {
          await mix(rec.dir, rec.path)
          rmSync(rec.dir, { recursive: true, force: true })
        }
        const bytes = statSync(rec.path).size
        if (bytes < 1024) throw new Error('recording is empty. Check Microphone permission for Alfredo in System Settings > Privacy & Security.')
        res({ id: rec.id, path: rec.path, durationS: Math.round((Date.now() - rec.startedAt) / 1000), bytes, systemAudio: rec.systemAudio })
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    }
    rec.proc.once('close', done)
    if (rec.backend === 'native') {
      rec.proc.kill('SIGINT')
    } else {
      // 'q' asks ffmpeg to finalise the container; a hard kill leaves the wav header unwritten.
      rec.proc.stdin?.write('q')
      rec.proc.stdin?.end()
    }
    setTimeout(() => {
      if (!settled) {
        try {
          rec.proc.kill('SIGKILL')
        } catch {}
        done()
      }
    }, 6000)
  })
}
