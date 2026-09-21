// Parakeet, on any machine.
//
// The Mac runs NVIDIA's parakeet-tdt-0.6b-v3 through FluidAudio, which is
// Swift on CoreML. The model itself is not Apple's and does not need any of
// that: the same weights exist as ONNX, and Alfredo already carries ONNX
// Runtime for its embeddings. This file is the other road to the same model,
// so Windows and Linux transcribe a meeting on the machine that recorded it
// rather than sending it anywhere.
//
// Three graphs, the way the export ships them:
//   nemo128.onnx          waveforms -> features, 128 log-mel bins
//   encoder-model.onnx    audio_signal -> outputs, 1024 per frame, 8x subsampled
//   decoder_joint.onnx    one frame + the last token -> 8193 tokens and 5 durations
//
// Decoding is TDT greedy, which is RNN-T with one addition: the joint network
// also says how many frames to skip, so silence costs one step instead of
// hundreds. Ported from onnx-asr, which is the reference for these exports.

import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { appHome } from './home'

const REPO = process.env.ALFREDO_PARAKEET_REPO ?? 'istupakov/parakeet-tdt-0.6b-v3-onnx'
const DIR = () => join(appHome(), 'models', 'parakeet')

/** The int8 export: the same weights as the Mac gets, about 640 MB in all. */
const FILES = ['nemo128.onnx', 'encoder-model.int8.onnx', 'decoder_joint-model.int8.onnx', 'vocab.txt']

export const ENGINE = 'parakeet-tdt-0.6b-v3 (onnx)'

/** Sixteen kHz, mono, which is what everything here records and what the model wants. */
const RATE = 16000
/** The model sees this much at once; a meeting is walked through in pieces. */
const CHUNK_S = 30
/** Each piece starts a little before the last one ended, so no word is cut in half. */
const OVERLAP_S = 2
/** One encoder frame after 8x subsampling, in seconds. */
const FRAME_S = 0.08

export const downloaded = () => FILES.every((f) => existsSync(join(DIR(), f)) && statSync(join(DIR(), f)).size > 0)

type Progress = { state: 'idle' | 'downloading' | 'ready' | 'failed'; got: number; of: number; bytes: number; error?: string }
let progress: Progress = { state: 'idle', got: 0, of: FILES.length, bytes: 0 }
export const downloadState = (): Progress => (downloaded() ? { ...progress, state: 'ready', got: FILES.length } : progress)

/** Fetch the model once, into Alfredo's own folder. Safe to call again. */
export async function download() {
  if (downloaded()) return (progress = { ...progress, state: 'ready', got: FILES.length })
  if (progress.state === 'downloading') return progress
  progress = { state: 'downloading', got: 0, of: FILES.length, bytes: 0 }
  mkdirSync(DIR(), { recursive: true })
  try {
    for (const name of FILES) {
      const to = join(DIR(), name)
      if (existsSync(to) && statSync(to).size > 0) {
        progress.got++
        continue
      }
      const r = await fetch(`https://huggingface.co/${REPO}/resolve/main/${name}`)
      if (!r.ok || !r.body) throw new Error(`could not fetch ${name} (${r.status})`)
      // Written beside itself and renamed, so a half-downloaded file is never
      // mistaken for a model.
      const part = `${to}.part`
      await pipeline(Readable.fromWeb(r.body as any), createWriteStream(part))
      await rename(part, to)
      progress.got++
      progress.bytes += statSync(to).size
    }
    progress.state = 'ready'
  } catch (e) {
    progress = { ...progress, state: 'failed', error: (e as Error).message }
    await Promise.all(FILES.map((f) => unlink(join(DIR(), `${f}.part`)).catch(() => {})))
  }
  return progress
}

// --- the model ------------------------------------------------------------------

type Session = import('onnxruntime-node').InferenceSession
let loaded: Promise<{ features: Session; encoder: Session; decoder: Session; vocab: string[]; blank: number }> | null = null

async function load() {
  if (!loaded) {
    loaded = (async () => {
      if (!downloaded()) throw new Error('the transcription model is not downloaded yet')
      const ort = await import('onnxruntime-node')
      const opts = { logSeverityLevel: 3 as const }
      const [features, encoder, decoder] = await Promise.all([
        ort.InferenceSession.create(join(DIR(), 'nemo128.onnx'), opts),
        ort.InferenceSession.create(join(DIR(), 'encoder-model.int8.onnx'), opts),
        ort.InferenceSession.create(join(DIR(), 'decoder_joint-model.int8.onnx'), opts),
      ])
      // "token id" a line, with the sentencepiece underscore standing for a space.
      const vocab: string[] = []
      for (const line of readFileSync(join(DIR(), 'vocab.txt'), 'utf8').split('\n')) {
        if (!line) continue
        const at = line.lastIndexOf(' ')
        if (at < 0) continue
        vocab[Number(line.slice(at + 1))] = line.slice(0, at).replaceAll('▁', ' ')
      }
      const blank = vocab.indexOf('<blk>')
      return { features, encoder, decoder, vocab, blank: blank >= 0 ? blank : vocab.length - 1 }
    })().catch((e) => {
      loaded = null
      throw e
    })
  }
  return loaded
}

/** 16 kHz mono PCM out of a wav this machine wrote. */
export function readWav(bytes: Buffer): Float32Array {
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF') throw new Error('not a wav file')
  let at = 12
  let format = 1
  let channels = 1
  let bits = 16
  while (at + 8 <= bytes.length) {
    const id = bytes.toString('ascii', at, at + 4)
    const size = bytes.readUInt32LE(at + 4)
    const body = at + 8
    if (id === 'fmt ') {
      format = bytes.readUInt16LE(body)
      channels = bytes.readUInt16LE(body + 2)
      bits = bytes.readUInt16LE(body + 14)
    } else if (id === 'data') {
      const end = size === 0 || size === 0xffffffff ? bytes.length : Math.min(bytes.length, body + size)
      return samples(bytes.subarray(body, end), format, channels, bits)
    }
    at = body + size + (size % 2)
  }
  throw new Error('wav file has no audio in it')
}

function samples(data: Buffer, format: number, channels: number, bits: number): Float32Array {
  const bytesPer = bits / 8
  const frames = Math.floor(data.length / (bytesPer * channels))
  const out = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    let sum = 0
    for (let c = 0; c < channels; c++) {
      const at = (i * channels + c) * bytesPer
      sum += format === 3 ? (bits === 64 ? data.readDoubleLE(at) : data.readFloatLE(at)) : bits === 32 ? data.readInt32LE(at) / 2147483648 : bits === 8 ? (data.readUInt8(at) - 128) / 128 : data.readInt16LE(at) / 32768
    }
    out[i] = sum / channels
  }
  return out
}

/** One pass of the model over one piece of audio, and the words it heard. */
async function listen(audio: Float32Array): Promise<{ text: string; at: number }[]> {
  const { features, encoder, decoder, vocab, blank } = await load()
  const ort = await import('onnxruntime-node')
  const { Tensor } = ort

  const mel = await features.run({
    waveforms: new Tensor('float32', audio, [1, audio.length]),
    waveforms_lens: new Tensor('int64', BigInt64Array.from([BigInt(audio.length)]), [1]),
  })
  const enc = await encoder.run({ audio_signal: mel['features'], length: mel['features_lens'] })
  const out = enc['outputs']
  const lens = enc['encoded_lengths']
  // [1, dim, time] as the encoder gives it; the decoder wants one frame at a time.
  const [, dim, time] = out.dims as number[]
  const frames = Math.min(Number((lens.data as BigInt64Array)[0]), time)
  const encoded = out.data as Float32Array

  let state1 = new Tensor('float32', new Float32Array(2 * 1 * 640), [2, 1, 640])
  let state2 = new Tensor('float32', new Float32Array(2 * 1 * 640), [2, 1, 640])

  const said: { text: string; at: number }[] = []
  const frame = new Float32Array(dim)
  let last = blank
  let t = 0
  let emitted = 0
  const MAX_PER_STEP = 10

  while (t < frames) {
    for (let d = 0; d < dim; d++) frame[d] = encoded[d * time + t]
    const step = await decoder.run({
      encoder_outputs: new Tensor('float32', frame, [1, dim, 1]),
      targets: new Tensor('int32', Int32Array.from([last]), [1, 1]),
      target_length: new Tensor('int32', Int32Array.from([1]), [1]),
      input_states_1: state1,
      input_states_2: state2,
    })
    const logits = step['outputs'].data as Float32Array
    const nextState1 = step['output_states_1'] as typeof state1
    const nextState2 = step['output_states_2'] as typeof state2

    // The first vocab_size numbers are the token; what follows says how many
    // frames to jump, which is what makes this TDT rather than plain RNN-T.
    let token = 0
    for (let i = 1; i < vocab.length; i++) if (logits[i] > logits[token]) token = i
    let jump = 0
    let best = -Infinity
    for (let i = vocab.length; i < logits.length; i++) {
      if (logits[i] > best) {
        best = logits[i]
        jump = i - vocab.length
      }
    }

    if (token !== blank) {
      state1 = nextState1
      state2 = nextState2
      last = token
      said.push({ text: vocab[token] ?? '', at: t * FRAME_S })
      emitted++
    }
    if (jump > 0) {
      t += jump
      emitted = 0
    } else if (token === blank || emitted >= MAX_PER_STEP) {
      t += 1
      emitted = 0
    }
  }
  return said
}

/**
 * A whole recording, in pieces the model can hold, with the pieces overlapping
 * so a word spoken across a seam is still heard once.
 */
export async function transcribeFile(path: string): Promise<string> {
  const audio = readWav(await readFile(path))
  const chunk = CHUNK_S * RATE
  const overlap = OVERLAP_S * RATE
  const out: string[] = []
  for (let start = 0; start < audio.length; start += chunk - overlap) {
    const piece = audio.subarray(start, Math.min(audio.length, start + chunk))
    if (piece.length < RATE / 4) break
    const said = await listen(piece)
    if (start === 0) {
      out.push(said.map((s) => s.text).join(''))
    } else {
      // Everything inside the overlap was already heard by the piece before
      // it. Starting at the first token that opens a word, rather than at the
      // second exactly, keeps a word the seam ran through from arriving as
      // its own tail: "15" cut in two is "1" there and "5." here.
      const kept = said.filter((s) => s.at >= OVERLAP_S)
      const opens = kept.findIndex((s) => s.text.startsWith(' '))
      out.push(kept.slice(opens < 0 ? 0 : opens).map((s) => s.text).join(''))
    }
    if (start + chunk >= audio.length) break
  }
  return out.join(' ').replace(/\s+/g, ' ').trim()
}
