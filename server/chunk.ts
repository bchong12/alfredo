// Cutting a document into the pieces that get looked up.
//
// Retrieval lives or dies here rather than on the model. Three things do the
// work: cut on the writing's own structure (headings, then paragraphs) so a
// piece is about one thing; overlap a little so a sentence split across two
// pieces is still findable; and put the title and the heading path in front
// of every piece, so a paragraph that says "we went with the second option"
// still carries what it is an option about.

export type Chunk = {
  /** What gets embedded: the context line, then the writing. */
  text: string
  /** Where it came from, for the citation. */
  heading: string
  ord: number
}

/** Rough token count. Four characters a token is close enough to size chunks by. */
const tokens = (s: string) => Math.ceil(s.length / 4)

const TARGET = 380
const OVERLAP = 60
const MIN = 40

type Piece = { heading: string; text: string }

/** Split on headings first: a heading is the writer saying "this is one thing". */
function sections(md: string): Piece[] {
  const lines = md.split('\n')
  const out: Piece[] = []
  const path: string[] = []
  let buf: string[] = []
  const flush = () => {
    const text = buf.join('\n').trim()
    if (text) out.push({ heading: path.join(' › '), text })
    buf = []
  }
  for (const line of lines) {
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      flush()
      const depth = h[1].length
      path.length = Math.min(path.length, depth - 1)
      path[depth - 1] = h[2].trim()
      continue
    }
    buf.push(line)
  }
  flush()
  return out
}

/** Paragraphs, then sentences, until the piece fits. */
function split(text: string, limit: number): string[] {
  if (tokens(text) <= limit) return [text]
  const parts = text.split(/\n{2,}/)
  const out: string[] = []
  let buf = ''
  const push = (s: string) => {
    if (s.trim()) out.push(s.trim())
  }
  for (const part of parts) {
    if (tokens(part) > limit) {
      push(buf)
      buf = ''
      // A paragraph too long to keep whole: sentences, then a hard cut.
      const sentences = part.split(/(?<=[.!?])\s+/)
      let line = ''
      for (const s of sentences) {
        const piece = tokens(s) > limit ? s.match(new RegExp(`[\\s\\S]{1,${limit * 4}}`, 'g')) ?? [s] : [s]
        for (const p of piece) {
          if (tokens(line) + tokens(p) > limit) {
            push(line)
            line = p
          } else line = line ? `${line} ${p}` : p
        }
      }
      push(line)
      continue
    }
    if (tokens(buf) + tokens(part) > limit) {
      push(buf)
      buf = part
    } else buf = buf ? `${buf}\n\n${part}` : part
  }
  push(buf)
  return out
}

/** The tail of a piece, carried into the next one so nothing falls between them. */
function tail(s: string, want: number) {
  const words = s.split(/\s+/)
  const take: string[] = []
  let n = 0
  for (let i = words.length - 1; i >= 0 && n < want; i--) {
    take.unshift(words[i])
    n = tokens(take.join(' '))
  }
  return take.join(' ')
}

/**
 * Chunks for one piece of work. `title` is the doc, meeting or card it is,
 * and rides in front of every chunk.
 */
export function chunkText(title: string, body: string, limit = TARGET): Chunk[] {
  const clean = (body ?? '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim()
  if (!clean) return []
  const out: Chunk[] = []
  let carry = ''
  for (const part of sections(clean)) {
    for (const piece of split(part.text, limit)) {
      const body = carry ? `${carry}\n${piece}` : piece
      if (tokens(body) < MIN && out.length) {
        // A scrap on its own is noise; it belongs with what came before.
        const last = out[out.length - 1]
        last.text = `${last.text}\n${piece}`
        carry = tail(piece, OVERLAP)
        continue
      }
      const where = [title, part.heading].filter(Boolean).join(' › ')
      out.push({ text: `${where}\n\n${body}`, heading: part.heading, ord: out.length })
      carry = tail(piece, OVERLAP)
    }
  }
  return out
}

/** A card is short; its title and body are one piece, and the title matters most. */
export const chunkCard = (ref: string, title: string, body: string): Chunk[] =>
  chunkText(`${ref} ${title}`.trim(), body?.trim() ? body : title)

/** A canvas is text scattered on a board; the words are what can be looked up. */
export function chunkCanvas(title: string, nodes: any[]): Chunk[] {
  const said = (n: any): string => {
    const d = n?.data ?? {}
    return [d.title, d.text, d.body, d.label].filter((x) => typeof x === 'string' && x.trim()).join(' — ')
  }
  const text = (nodes ?? []).map(said).filter(Boolean).join('\n\n')
  return chunkText(title, text)
}
