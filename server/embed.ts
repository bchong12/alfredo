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

import { join } from 'node:path'
import { existsSync, rmSync } from 'node:fs'
import { appHome } from './home'
import type { FeatureExtractionPipeline } from '@huggingface/transformers'

export const EMBED_MODEL = process.env.ALFREDO_EMBED_MODEL ?? 'Xenova/bge-small-en-v1.5'
export const EMBED_DIMS = Number(process.env.ALFREDO_EMBED_DIMS ?? 384)
const DTYPE = (process.env.ALFREDO_EMBED_DTYPE ?? 'q8') as 'q8' | 'fp32'

const MODELS = join(appHome(), 'models')

let pipe: Promise<FeatureExtractionPipeline> | null = null
let state: 'idle' | 'loading' | 'ready' | 'failed' = 'idle'
let problem = ''

/** Whether the model is already on this Mac, so nothing has to be downloaded. */
export function embedderDownloaded() {
  const dir = join(MODELS, ...EMBED_MODEL.split('/'))
  return existsSync(dir)
}

export function embedderState() {
  return { model: EMBED_MODEL, dims: EMBED_DIMS, downloaded: embedderDownloaded(), state, error: problem || undefined }
}

/**
 * The runtime is loaded when the first question or save needs it, never at
 * startup: it is a native module and tens of megabytes, and the rest of
 * Alfredo must open whether or not it is there.
 */
async function start(): Promise<FeatureExtractionPipeline> {
  const { env: hfEnv, pipeline } = await import('@huggingface/transformers')
  hfEnv.cacheDir = MODELS
  hfEnv.allowLocalModels = true
  try {
    return await pipeline('feature-extraction', EMBED_MODEL, { dtype: DTYPE })
  } catch (e) {
    // Two copies of Alfredo fetching the model at once leave half a file
    // behind, and half a file never loads. Throw it away and fetch again.
    const dir = join(MODELS, ...EMBED_MODEL.split('/'))
    if (!existsSync(dir)) throw e
    rmSync(dir, { recursive: true, force: true })
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
