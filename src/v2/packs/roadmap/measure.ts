// How tall a step's card has to be for its words.
//
// The map places every card itself, so it has to know a card's height before
// the card is drawn. The words are set in a hidden box of the same width and
// type and the browser is asked how tall that came out, which is the only
// measure that wraps a line where the card will wrap it.
import { CARD_H, CARD_W, type Standing, type Step } from './model'

const PAD = 12
const GAP = 8
const TOP = 16
const FACE = 20
const INNER = CARD_W - PAD * 2

/** What the foot of a card says about where the step stands. */
export function standingWords(at: Standing): string {
  if (at.kind === 'ready') return 'Ready to start'
  if (at.kind === 'doing') return 'Under way'
  if (at.kind === 'done') return 'Done'
  if (at.kind === 'decision') return `Needs ${at.decisions.length === 1 ? 'a decision' : `${at.decisions.length} decisions`}`
  return `After ${at.steps.map((x) => x.title).join(', ')}`
}

let box: HTMLDivElement | null = null
const seen = new Map<string, number>()

function tall(text: string, width: number, font: string, line: number): number {
  if (typeof document === 'undefined') return line
  const key = `${width}|${font}|${text}`
  const known = seen.get(key)
  if (known !== undefined) return known
  if (!box) {
    box = document.createElement('div')
    box.setAttribute('aria-hidden', 'true')
    box.style.cssText = 'position:fixed;left:-9999px;top:0;visibility:hidden;pointer-events:none;overflow-wrap:anywhere;white-space:normal;box-sizing:border-box'
    // Inside the app, so it is set in the app's own type.
    ;(document.querySelector('.shell') ?? document.body).appendChild(box)
  }
  box.style.width = `${width}px`
  box.style.font = font
  box.style.lineHeight = `${line}px`
  box.textContent = text
  const h = Math.max(line, Math.ceil(box.getBoundingClientRect().height))
  seen.set(key, h)
  return h
}

/** The type changed under us (a font finished loading): measure again. */
export const forgetMeasures = () => seen.clear()

export function cardHeight(step: Step, at: Standing, owners: number): number {
  const family = typeof document === 'undefined' ? 'sans-serif' : getComputedStyle(document.body).fontFamily
  const title = tall(step.title, INNER, `500 13px ${family}`, 18)
  // The faces overlap by five; with nobody, the word "Unassigned" is there instead.
  const faces = owners ? FACE + (owners - 1) * (FACE - 5) + (step.undecided ? 12 : 0) : 66
  const words = tall(standingWords(at), INNER - faces - GAP - 12, `400 12px ${family}`, 16)
  return Math.max(CARD_H, PAD + TOP + GAP + title + GAP + Math.max(FACE, words) + PAD)
}
