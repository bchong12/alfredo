// Passages kept on this Mac, for a workspace whose database cannot keep them.
//
// A workspace on somebody else's Worker (a team's own, older than questions
// are, and not ours to redeploy over) has nowhere to put what the brain reads
// in. It used to mean the brain simply did not work there, and said nothing.
// But the passages are cut and turned into numbers on this Mac anyway, and
// only ever asked about from this Mac, so this Mac can hold them: one file a
// workspace, beside the models that made them.
//
// Scored the way the Worker scores (cloudflare/worker.mjs): nearness of
// meaning and the question's own words, each ranked, the ranks fused. A few
// thousand passages is nothing to go through in memory.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { appHome } from './home'
import type { ChunkRow, Hit, ItemKind } from './v2'

type Kept = { kind: ItemKind; itemId: string; ord: number; title: string; heading: string; text: string; v: string }

const shelves = new Map<string, Shelf>()
export const shelfFor = (workspace: string): Shelf => {
  let shelf = shelves.get(workspace)
  if (!shelf) shelves.set(workspace, (shelf = new Shelf(workspace)))
  return shelf
}

/* Numbers as text are eight bytes each; as the floats they are, four, and a
   file of them a third the size. */
const pack = (numbers: number[]) => Buffer.from(new Float32Array(numbers).buffer).toString('base64')
const unpack = (text: string) => {
  const bytes = Buffer.from(text, 'base64')
  return new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4))
}

export class Shelf {
  private rows: Kept[] | null = null
  private vectors = new Map<Kept, Float32Array>()
  private saving: ReturnType<typeof setTimeout> | null = null
  private file: string

  constructor(workspace: string) {
    this.file = join(appHome(), 'brain', `${workspace.replace(/[^a-z0-9_-]/gi, '_')}.json`)
  }

  private all(): Kept[] {
    if (!this.rows) {
      try {
        this.rows = existsSync(this.file) ? (JSON.parse(readFileSync(this.file, 'utf8')) as Kept[]) : []
      } catch {
        this.rows = []
      }
    }
    return this.rows
  }

  /** Written a moment after the last change, whole, and swapped into place:
   *  reading a workspace in is hundreds of puts, and a file half written is a
   *  brain lost. */
  private save() {
    if (this.saving) clearTimeout(this.saving)
    this.saving = setTimeout(() => {
      this.saving = null
      try {
        mkdirSync(dirname(this.file), { recursive: true })
        writeFileSync(`${this.file}.part`, JSON.stringify(this.all()))
        renameSync(`${this.file}.part`, this.file)
      } catch {}
    }, 400)
  }

  put(kind: ItemKind, itemId: string, rows: ChunkRow[]) {
    this.rows = this.all().filter((r) => !(r.kind === kind && r.itemId === itemId))
    for (const r of rows) this.rows.push({ kind, itemId, ord: r.ord, title: r.title, heading: r.heading, text: r.text, v: pack(Array.from(r.embedding)) })
    this.save()
  }

  drop(kind: ItemKind, itemId: string) {
    const before = this.all().length
    this.rows = this.all().filter((r) => !(r.kind === kind && r.itemId === itemId))
    if (this.rows.length !== before) this.save()
  }

  count() {
    return this.all().length
  }

  search({ vector, text, limit }: { vector: number[]; text: string; limit: number }): Hit[] {
    const want = new Float32Array(vector)
    const words = text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2)
    const take = Math.min(Math.max(limit || 12, 1), 50)
    const dense: { r: Kept; dot: number }[] = []
    const lexical: { r: Kept; hits: number }[] = []
    for (const r of this.all()) {
      let v = this.vectors.get(r)
      if (!v) this.vectors.set(r, (v = unpack(r.v)))
      let dot = 0
      const n = Math.min(v.length, want.length)
      for (let i = 0; i < n; i++) dot += v[i] * want[i]
      dense.push({ r, dot })
      // The word half: how much of the question this passage actually says.
      const hay = `${r.title} ${r.heading} ${r.text}`.toLowerCase()
      const hits = words.filter((w) => hay.includes(w)).length
      if (hits) lexical.push({ r, hits })
    }
    dense.sort((a, b) => b.dot - a.dot)
    lexical.sort((a, b) => b.hits - a.hits)
    // Reciprocal rank fusion, the same as the Worker and the Postgres side.
    const score = new Map<Kept, number>()
    dense.slice(0, take * 4).forEach(({ r }, i) => score.set(r, (score.get(r) ?? 0) + 1 / (60 + i + 1)))
    lexical.slice(0, take * 4).forEach(({ r }, i) => score.set(r, (score.get(r) ?? 0) + 1 / (60 + i + 1)))
    return [...score.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, take)
      .map(([r, s]) => ({ kind: r.kind, itemId: r.itemId, ord: r.ord, title: r.title, heading: r.heading, text: r.text, score: s }))
  }
}
