// The ffmpeg-backed audio path: the Mac's microphone and imported audio files.
// Node only, and kept out of ai.ts so the edge bundle carries no Node built-ins.

import { spawn } from 'node:child_process'
import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { BITRATE_KBPS, TRANSCRIBE_MODEL, transcribeChunk } from './ai'
import { localKey } from './keys'
import { PARAKEET_ENGINE, parakeetAvailable, transcribeLocal } from './parakeet'

/** Audio per request. Amigo used 30 minutes; 20 leaves more headroom. */
const SEGMENT_SECONDS = 20 * 60
/**
 * mp3 mono 24kHz at 32kbps, with an 80Hz highpass borrowed from Amigo's lecture
 * pipeline to drop room rumble before it eats into the bitrate.
 *
 * Opus is a better codec, but OpenRouter's audio format support varies by
 * provider and mp3 is the one every provider accepts. Model portability is the
 * whole reason we are on OpenRouter, so we pay a few MB for it.
 */
export function compress(wavPath: string): Promise<string> {
  const out = wavPath.replace(/\.wav$/, '.mp3')
  return new Promise((res, reject) => {
    const p = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-i', wavPath,
      '-af', 'highpass=f=80',
      '-ac', '1', '-ar', '24000', '-b:a', `${BITRATE_KBPS}k`, '-c:a', 'libmp3lame',
      '-y', out,
    ])
    let err = ''
    p.stderr.on('data', (d) => (err += d))
    p.on('close', (c) => (c === 0 ? res(out) : reject(new Error(`ffmpeg compress failed: ${err}`))))
  })
}

/**
 * Split into fixed-length segments. A single two-hour request is where
 * transcription quality quietly falls apart — the model starts summarizing
 * instead of transcribing — and OpenRouter has no file-upload API, so every
 * request carries its audio inline as base64.
 */
function split(mp3Path: string, seconds: number): Promise<string[]> {
  const dir = dirname(mp3Path)
  const stem = basename(mp3Path).replace(/\.mp3$/, '')
  const pattern = join(dir, `${stem}-part%03d.mp3`)
  return new Promise((res, reject) => {
    const p = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-i', mp3Path,
      '-f', 'segment',
      '-segment_time', String(seconds),
      '-reset_timestamps', '1',
      '-c:a', 'copy',
      '-y', pattern,
    ])
    let err = ''
    p.stderr.on('data', (d) => (err += d))
    p.on('close', async (c) => {
      if (c !== 0) return reject(new Error(`ffmpeg split failed: ${err}`))
      const parts = (await readdir(dir))
        .filter((f) => f.startsWith(`${stem}-part`) && f.endsWith('.mp3'))
        .sort()
        .map((f) => join(dir, f))
      res(parts)
    })
  })
}

async function transcribeOne(path: string, hint: string) {
  const data = (await readFile(path)).toString('base64')
  return transcribeChunk(localKey(), data, 'mp3', hint)
}

/** One request, one self-contained audio chunk, already base64. */
export async function transcribe(audioPath: string) {
  // On this Mac, Parakeet: the whole file, no segmenting, nothing uploaded.
  if (parakeetAvailable()) {
    const bytes = await readFile(audioPath)
    const text = await transcribeLocal(new Uint8Array(bytes), audioPath.split('.').pop() ?? 'wav')
    return { text, engine: PARAKEET_ENGINE, audioPath, parts: 1 }
  }
  const mp3 = audioPath.endsWith('.mp3') ? audioPath : await compress(audioPath)
  const { size } = await stat(mp3)

  const approxSeconds = size / ((BITRATE_KBPS * 1000) / 8)
  const parts =
    approxSeconds > SEGMENT_SECONDS * 1.2 ? await split(mp3, SEGMENT_SECONDS) : [mp3]

  const chunks: string[] = []
  for (const [i, part] of parts.entries()) {
    const hint =
      parts.length > 1
        ? `\n\nThis is part ${i + 1} of ${parts.length} of one meeting. It begins mid-conversation; transcribe from the first word you hear without preamble about missing context.`
        : ''
    chunks.push(await transcribeOne(part, hint))
  }

  return { text: chunks.join('\n\n'), engine: TRANSCRIBE_MODEL, audioPath: mp3, parts: parts.length }
}

/**
 * strict mode requires every property to appear in `required` and every object
 * to set additionalProperties:false. Fields that are logically optional are
 * therefore required-but-empty: assignee and due come back as "" when the
 * meeting did not name one.
 */
