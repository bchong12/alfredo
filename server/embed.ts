// Turning the workspace's writing into vectors, on this Mac.
//
// The model is bge-small-en-v1.5, quantised to int8: 384 numbers per chunk,
// about 34 MB on disk. It is small on purpose. What makes retrieval good is
// not a bigger model but better chunks, a lexical pass beside the vectors,
// and a reranking step; the model only has to put "what did we decide about
// pricing" near the paragraph where pricing was decided, which this one does.
//
// It downloads on first use and is kept with the rest of Alfredo's things, so
// nothing about a workspace's writing leaves the machine.

import { join, dirname } from 'node:path'
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { appHome } from './home'
import type { FeatureExtractionPipeline } from '@huggingface/transformers'

export const EMBED_MODEL = process.env.ALFREDO_EMBED_MODEL ?? 'Xenova/bge-small-en-v1.5'
export const EMBED_DIMS = Number(process.env.ALFREDO_EMBED_DIMS ?? 384)
const DTYPE = (process.env.ALFREDO_EMBED_DTYPE ?? 'q8') as 'q8' | 'fp32'

const MODELS = join(appHome(), 'models')

/** The four files a feature-extraction model needs, and nothing else. */
const FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx']

let pipe: Promise<FeatureExtractionPipeline> | null = null
let state: 'idle' | 'loading' | 'downloading' | 'ready' | 'failed' = 'idle'
let problem = ''
let got = 0

const modelDir = () => join(MODELS, ...EMBED_MODEL.split('/'))

/** Whether the model is already on this Mac, so nothing has to be downloaded. */
export const embedderDownloaded = () => FILES.every((f) => existsSync(join(modelDir(), f)) && statSync(join(modelDir(), f)).size > 0)

export function embedderState() {
  return { model: EMBED_MODEL, dims: EMBED_DIMS, downloaded: embedderDownloaded(), state, files: got, of: FILES.length, error: problem || undefined }
}

/**
 * Fetch the model ourselves rather than leaving it to the library's cache,
 * which quietly hands back nothing when it cannot write, and then the only
 * symptom is a model that will not load. Four files, written once, and a
 * count the Models screen can show while they arrive.
 */
async function download() {
  state = 'downloading'
  got = 0
  for (const file of FILES) {
    const to = join(modelDir(), file)
    if (existsSync(to) && statSync(to).size > 0) {
      got++
      continue
    }
    const from = `https://huggingface.co/${EMBED_MODEL}/resolve/main/${file}`
    const r = await fetch(from)
    if (!r.ok) throw new Error(`Could not fetch ${file} for ${EMBED_MODEL} (${r.status}).`)
    mkdirSync(dirname(to), { recursive: true })
    await writeFile(to, Buffer.from(await r.arrayBuffer()))
    got++
  }
}

/**
 * The runtime is loaded when the first question or save needs it, never at
 * startup: it is a native module and tens of megabytes, and the rest of
 * Alfredo must open whether or not it is there.
 */
async function start(): Promise<FeatureExtractionPipeline> {
  if (!embedderDownloaded()) await download()
  const { env: hfEnv, pipeline } = await import('@huggingface/transformers')
  // Everything is on disk already, so it loads from there and asks nobody.
  hfEnv.localModelPath = MODELS
  hfEnv.cacheDir = MODELS
  hfEnv.allowLocalModels = true
  hfEnv.allowRemoteModels = false
  state = 'loading'
  try {
    return await pipeline('feature-extraction', EMBED_MODEL, { dtype: DTYPE })
  } catch (e) {
    // A half-written file never loads. Throw it away and fetch it again.
    rmSync(modelDir(), { recursive: true, force: true })
    await download()
    state = 'loading'
    return pipeline('feature-extraction', EMBED_MODEL, { dtype: DTYPE })
  }
}

function load() {
  if (!pipe) {
    state = 'loading'
    pipe = start()
      .then((p) => {
        state = 'ready'
        problem = ''
        return p
      })
      .catch((e) => {
        state = 'failed'
        problem = (e as Error).message
        // A later question may well work: a network came back, or the other
        // copy of Alfredo finished. Let it try again rather than stay broken.
        pipe = null
        throw e
      })
  }
  return pipe
}

/** Warm the model up (and download it the first time) without embedding anything. */
export async function readyEmbedder() {
  await load()
  return embedderState()
}

/**
 * Vectors for a batch of texts, already normalised, so a dot product is the
 * cosine. Sixteen at a time: bigger batches stop helping on a laptop CPU.
 */
export async function embed(texts: string[]): Promise<number[][]> {
  if (!texts.length) return []
  const run = await load()
  const out: number[][] = []
  for (let i = 0; i < texts.length; i += 16) {
    const batch = texts.slice(i, i + 16).map((t) => t.slice(0, 4000))
    const res = await run(batch, { pooling: 'mean', normalize: true })
    out.push(...(res.tolist() as number[][]))
  }
  return out
}

/**
 * The query side of the same model. bge wants a line in front of a question,
 * which is worth a few points of recall and costs nothing.
 */
export const embedQuery = async (q: string) =>
  (await embed([EMBED_MODEL.includes('bge') ? `Represent this sentence for searching relevant passages: ${q}` : q]))[0]

/** Postgres wants a vector literal, not an array. */
export const toVector = (v: number[]) => `[${v.map((x) => x.toFixed(6)).join(',')}]`
