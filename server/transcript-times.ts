// When each thing was said.
//
// Both engines know when every word was spoken and the transcript used to
// throw it away, which leaves an hour of meeting as one block of text with no
// way to find the ten minutes about pricing. Kept as text, so every database
// holds it, a search finds it and a copy carries it: each paragraph opens with
// the moment it began, "[12:40] ", and the page draws that in the margin.

export type Word = { word: string; start: number; end: number }

export const clock = (seconds: number) => {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const two = (n: number) => String(n).padStart(2, '0')
  return h ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`
}

/** A new paragraph where somebody stopped talking, or where one has run long
 *  enough and a sentence has just ended: a breath, not a word count.
 *
 *  The engines say when a word ENDS by when the next begins, so a silence is
 *  folded into the word before it and an "end" cannot be trusted to find one.
 *  What can be: how long after a word began the next one did, less the time
 *  the word itself takes to say. */
const BREATH_S = 1.0
const SILENCE_S = 2.0
const LONG_S = 28
const TOO_LONG_S = 70
const saying = (word: string) => Math.min(0.9, 0.07 * word.length)

export function withTimes(words: Word[]): string {
  const paragraphs: { at: number; words: string[] }[] = []
  let last: Word | null = null
  for (const w of words) {
    if (!w.word.trim()) continue
    const open = paragraphs[paragraphs.length - 1]
    const quiet = last ? w.start - last.start - saying(last.word) : Infinity
    const ended = !!last && /[.?!]["')\]]?$/.test(last.word)
    const ranLong = !!open && ((w.start - open.at >= LONG_S && ended) || w.start - open.at >= TOO_LONG_S)
    if (!open || quiet >= SILENCE_S || (quiet >= BREATH_S && ended) || ranLong) paragraphs.push({ at: w.start, words: [w.word.trim()] })
    else open.words.push(w.word.trim())
    last = w
  }
  return paragraphs.map((p) => `[${clock(p.at)}] ${p.words.join(' ')}`).join('\n\n')
}

/** A transcript as the page draws it: the moment, then what was said. Text
 *  with no moments in it (an older meeting, a pasted transcript) is one part. */
export function parts(transcript: string): { at: string | null; text: string }[] {
  return transcript
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const m = /^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*/.exec(block)
      return m ? { at: m[1], text: block.slice(m[0].length) } : { at: null, text: block }
    })
}
