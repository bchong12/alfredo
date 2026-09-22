// Parakeet, on this Mac, through FluidAudio's command-line tool.
//
// Transcription for local workspaces never leaves the machine: the browser's
// webm segment becomes a 16 kHz mono wav via ffmpeg, the FluidAudio CLI runs
// Parakeet TDT on it, and the words come back on stdout. No key, no bill, no
// upload. A hosted deployment cannot do this (there is no Mac behind it)
// and keeps using the hosted model; see meetings.ts for the seam.
//
// The binary is built once by scripts/build-parakeet.sh into ~/.alfredo/bin.
// Models download on first run to ~/Library/Application Support/FluidAudio.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { HOME } from './workspaces'
import type { Word } from './transcript-times'

const run = promisify(execFile)

export const PARAKEET_ENGINE = 'parakeet-tdt-0.6b-v3'

export function parakeetBin() {
  const fromEnv = process.env.FLUIDAUDIO_CLI
  if (fromEnv && existsSync(fromEnv)) return fromEnv
  const local = join(HOME, 'bin', 'fluidaudiocli')
  return existsSync(local) ? local : null
}

export const parakeetAvailable = () => parakeetBin() !== null && ffmpegAvailable()

let ffmpegKnown: boolean | null = null
function ffmpegAvailable() {
  if (ffmpegKnown !== null) return ffmpegKnown
  ffmpegKnown = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'].some(existsSync)
  return ffmpegKnown
}

function ffmpeg() {
  return ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'].find(existsSync) ?? 'ffmpeg'
}

/**
 * Transcribe one recorded segment. `bytes` is whatever the browser produced
 * (webm/opus, mp4, wav); the container does not matter because ffmpeg reads
 * it and writes the wav Parakeet wants.
 */
export async function transcribeLocal(bytes: Uint8Array, ext: string): Promise<string> {
  return (await transcribeLocalTimed(bytes, ext)).text
}

/** The same, with when each word was said: the CLI writes that to a file
 *  beside the wav, and prints only the words. */
export async function transcribeLocalTimed(bytes: Uint8Array, ext: string): Promise<{ text: string; words: Word[] }> {
  const bin = parakeetBin()
  if (!bin) throw new Error('Parakeet is not installed. Run scripts/build-parakeet.sh.')
  const dir = await mkdtemp(join(tmpdir(), 'alfredo-stt-'))
  try {
    const src = join(dir, `src.${ext || 'webm'}`)
    const wav = join(dir, 'in.wav')
    const timed = join(dir, 'out.json')
    await writeFile(src, bytes)
    await run(ffmpeg(), ['-v', 'error', '-y', '-i', src, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], {
      timeout: 120_000,
    })
    const { stdout } = await run(bin, ['transcribe', wav, '--output-json', timed], {
      timeout: 15 * 60_000,
      maxBuffer: 64 * 1024 * 1024,
    })
    let words: Word[] = []
    let text = stdout.trim()
    try {
      const d = JSON.parse(await readFile(timed, 'utf8')) as { text?: string; wordTimings?: { word: string; startTime: number; endTime: number }[] }
      words = (d.wordTimings ?? []).map((w) => ({ word: w.word, start: w.startTime, end: w.endTime }))
      /* With the file asked for, the words may go there and not to the screen. */
      if (d.text?.trim()) text = d.text.trim()
    } catch {
      /* An older build of the CLI: the words alone, as before. */
    }
    return { text, words }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * Speaker turns for a whole meeting: who spoke when, from FluidAudio's
 * offline diarization. Optional, and slower than transcription, so it runs
 * only when asked for from the meeting page.
 */
export async function diarizeLocal(bytes: Uint8Array, ext: string) {
  const bin = parakeetBin()
  if (!bin) throw new Error('Parakeet is not installed.')
  const dir = await mkdtemp(join(tmpdir(), 'alfredo-dia-'))
  try {
    const src = join(dir, `src.${ext || 'webm'}`)
    const wav = join(dir, 'in.wav')
    const out = join(dir, 'out.json')
    await writeFile(src, bytes)
    await run(ffmpeg(), ['-v', 'error', '-y', '-i', src, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], {
      timeout: 120_000,
    })
    await run(bin, ['process', wav, '--mode', 'offline', '--output', out], {
      timeout: 30 * 60_000,
      maxBuffer: 64 * 1024 * 1024,
    })
    const { readFile } = await import('node:fs/promises')
    return JSON.parse(await readFile(out, 'utf8')) as {
      segments?: { speakerId: string; startTimeSeconds: number; endTimeSeconds: number }[]
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
