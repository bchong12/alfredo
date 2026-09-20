// The company brain: keeping the workspace's writing findable, and answering
// questions from it.
//
// Two halves. Indexing watches what changes (a doc saved, a meeting written
// up, a card edited), cuts it into chunks, embeds them on this Mac and puts
// them beside the work. Asking runs the hybrid search, then hands the best
// passages to Claude Code with instructions to answer only from them and to
// say which piece of work each claim came from.
//
// What a question may reach is never decided here: the search runs as the
// person asking, so a project they are not in cannot be found, let alone
// quoted.

import { chunkCanvas, chunkCard, chunkText } from './chunk'
import { embed, embedQuery, embedderState, readyEmbedder } from './embed'
import { hasLocalChat, chat, EXTRACT_MODEL } from './ai'
import type { Hit, ItemKind, Store } from './v2'

export type Citation = { kind: ItemKind; itemId: string; title: string; heading?: string }
export type Answer = { answer: string; citations: Citation[]; used: number; model: string }

// --- indexing ------------------------------------------------------------------

/** The writing behind one piece of work, ready to be cut up. */
async function readItem(store: Store, kind: ItemKind, id: string) {
  if (kind === 'doc') {
    const d = await store.doc(id)
    return { title: d.title, chunks: chunkText(d.title, d.body) }
  }
  if (kind === 'meeting') {
    const m = await store.meeting(id)
    const body = [m.notes, m.transcript ? `## Transcript\n\n${m.transcript}` : ''].filter(Boolean).join('\n\n')
    return { title: m.title, chunks: chunkText(m.title, body) }
  }
  if (kind === 'canvas') {
    const c = await store.canvas(id)
    return { title: c.title, chunks: chunkCanvas(c.title, c.nodes) }
  }
  const card = (await store.cardsIn('backlog')).find((c) => c.id === id) ?? (await store.cardsIn([]))[0]
  if (!card) return null
  return { title: `${card.ref} ${card.title}`, chunks: chunkCard(card.ref, card.title, card.body) }
}

/**
 * One workspace's queue. Saving a doc three times in a minute should cost one
 * indexing pass, and indexing must never make a save wait.
 */
type Job = { store: Store; kind: ItemKind; id: string; at: number }
const queued = new Map<string, Job>()
let working = false
const QUIET_MS = 1500

async function work() {
  if (working) return
  working = true
  try {
    for (;;) {
      const now = Date.now()
      const next = [...queued.entries()].find(([, j]) => now - j.at >= QUIET_MS)
      if (!next) break
      const [key, job] = next
      queued.delete(key)
      try {
        await indexItem(job.store, job.kind, job.id)
      } catch {
        // A single unindexable item must not stop the rest.
      }
    }
  } finally {
    working = false
    if (queued.size) setTimeout(() => work(), QUIET_MS)
  }
}

/** Say that something changed. Returns at once; the work happens behind it. */
export function touch(store: Store, kind: ItemKind, id: string, workspace = '') {
  queued.set(`${workspace}|${kind}|${id}`, { store, kind, id, at: Date.now() })
  setTimeout(() => work(), QUIET_MS + 50)
}

/** Say that something is gone, so a question can no longer find it. */
export async function forget(store: Store, kind: ItemKind, id: string) {
  queued.delete(`|${kind}|${id}`)
  await store.dropChunks(kind, id).catch(() => {})
}

/** Cut one piece of work up, embed it, and keep it beside the work. */
export async function indexItem(store: Store, kind: ItemKind, id: string) {
  const item = await readItem(store, kind, id)
  if (!item || !item.chunks.length) {
    await store.dropChunks(kind, id).catch(() => {})
    return 0
  }
  const vectors = await embed(item.chunks.map((c) => c.text))
  await store.putChunks(
    kind,
    id,
    item.chunks.map((c, i) => ({ ord: c.ord, title: item.title, heading: c.heading, text: c.text, embedding: vectors[i] })),
  )
  return item.chunks.length
}

export type Progress = { state: 'idle' | 'running' | 'done' | 'failed'; done: number; total: number; chunks: number; error?: string; at: number }
const runs = new Map<string, Progress>()
export const indexProgress = (workspace: string): Progress => runs.get(workspace) ?? { state: 'idle', done: 0, total: 0, chunks: 0, at: 0 }

/** Everything the workspace has, from the beginning. Safe to run again. */
export function reindex(store: Store, workspace: string) {
  const have = runs.get(workspace)
  if (have?.state === 'running') return have
  const p: Progress = { state: 'running', done: 0, total: 0, chunks: 0, at: Date.now() }
  runs.set(workspace, p)
  ;(async () => {
    await readyEmbedder()
    const [docs, canvases, meetings, cards, backlog] = await Promise.all([
      store.docs(),
      store.canvases(),
      store.meetings(),
      store.cardsIn([]).catch(() => []),
      store.cardsIn('backlog').catch(() => []),
    ])
    const work: [ItemKind, string][] = [
      ...docs.map((d) => ['doc', d.id] as [ItemKind, string]),
      ...canvases.map((c) => ['canvas', c.id] as [ItemKind, string]),
      ...meetings.map((m) => ['meeting', m.id] as [ItemKind, string]),
      ...[...cards, ...backlog].map((c) => ['card', c.id] as [ItemKind, string]),
    ]
    p.total = work.length
    for (const [kind, id] of work) {
      try {
        p.chunks += await indexItem(store, kind, id)
      } catch {
        // Skip what cannot be read; the count says how much made it.
      }
      p.done++
    }
    p.state = 'done'
  })().catch((e) => {
    p.state = 'failed'
    p.error = (e as Error).message
  })
  return p
}

// --- asking ---------------------------------------------------------------------

/** The passages a question should be answered from. */
export async function findPassages(store: Store, question: string, limit = 14): Promise<Hit[]> {
  const vector = await embedQuery(question)
  return store.searchChunks({ vector, text: question, limit })
}

/** Narrowing, when the app knows more than the database about what is in view. */
export type InView = (hits: Hit[]) => Promise<Hit[]>

const PROMPT = `You answer questions about a company's own work: its docs, meetings, board cards and canvases.

Rules:
- Answer only from the passages given. They are all you know.
- When the passages do not say, reply that the workspace does not say, and name what would have to be written down. Never fill the gap from anywhere else.
- Cite with the bracketed number of every passage you used, like [2], right after the sentence that used it.
- Be short. Lead with the answer, then what supports it. No preamble.
- Quote a decision or a number exactly as it is written.`

/** What the model is shown: the passages, numbered, with where each came from. */
const asContext = (hits: Hit[]) =>
  hits
    .map((h, i) => `[${i + 1}] ${h.title}${h.heading ? ` › ${h.heading}` : ''} (${h.kind})\n${h.text}`)
    .join('\n\n---\n\n')

/**
 * Ask the workspace something.
 *
 * Answered by Claude Code on this Mac, and nowhere else. A company's own
 * writing is the last thing to hand to a service nobody chose, so there is no
 * hosted fallback here at all: no Claude Code, no answer, and it says so.
 */
export async function ask(store: Store, question: string, limit = 14, inView?: InView): Promise<Answer> {
  // Ask for extra, because narrowing to the open project drops some.
  const found = await findPassages(store, question, inView ? limit * 2 : limit)
  const hits = (inView ? await inView(found) : found).slice(0, limit)
  if (!hits.length) {
    return {
      answer: embedderState().downloaded
        ? 'Nothing in this workspace touches that yet.'
        : 'The workspace has not been read in yet. Start that from Settings > Models, then ask again.',
      citations: [],
      used: 0,
      model: 'none',
    }
  }
  if (!hasLocalChat()) {
    // The passages are still worth handing back: they are the answer, unwritten.
    return {
      answer: `Found ${hits.length} passages, but Claude Code is not on this Mac to write the answer. Install it (\`claude\` on your PATH) and ask again; until then, the passages below are what the workspace says.`,
      citations: hits.slice(0, 5).map((h) => ({ kind: h.kind, itemId: h.itemId, title: h.title, heading: h.heading || undefined })),
      used: hits.length,
      model: 'none',
    }
  }
  const text = await chat('', EXTRACT_MODEL, `${PROMPT}\n\nPassages:\n\n${asContext(hits)}\n\nQuestion: ${question}`)
  // Only the passages actually cited become citations, in the order used.
  const cited = [...text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])).filter((n) => n >= 1 && n <= hits.length)
  const order = [...new Set(cited.length ? cited : hits.slice(0, 3).map((_, i) => i + 1))]
  const seen = new Set<string>()
  const citations: Citation[] = []
  for (const n of order) {
    const h = hits[n - 1]
    const key = `${h.kind}:${h.itemId}`
    if (seen.has(key)) continue
    seen.add(key)
    citations.push({ kind: h.kind, itemId: h.itemId, title: h.title, heading: h.heading || undefined })
  }
  return { answer: text.trim(), citations, used: hits.length, model: 'claude code (local)' }
}
