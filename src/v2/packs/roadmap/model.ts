// A roadmap that is an order, not a calendar.
//
// Every project tool draws a roadmap as bars across months, which needs a
// start and an end for every piece of work. A plan in its first weeks has
// neither: what it has is an order ("brand before build"), owners, and a few
// decisions that everything waits on. Give that a date chart and the dates
// are invented, and an invented date looks exactly like a promise.
//
// So this keeps what a plan like that actually knows: steps, what each waits
// on, who owns it, and the decisions standing in the way. From those it works
// out the one thing worth asking of a roadmap every morning: what can start
// today, and what is stuck, on what, and on whom. A date is welcome on a step
// and never required.
//
// Pure: no DOM, no store. The tab draws what comes out of here.

export type StepState = 'todo' | 'doing' | 'done'
export type Step = {
  id: string
  title: string
  note?: string
  /** People in the workspace by id, or anybody else by name. */
  owners: string[]
  /** More than one owner, and which of them is not settled yet. */
  undecided?: boolean
  /** Steps this one cannot start before. */
  after: string[]
  state: StepState
  due?: string
}
export type Decision = {
  id: string
  question: string
  /** Who decides: a person's id or a name. */
  owner?: string
  /** Steps that cannot start until this is settled. */
  blocks: string[]
  /** Settled once it has an answer. */
  answer?: string
}
export type Roadmap = { steps: Step[]; decisions: Decision[] }

export const EMPTY: Roadmap = { steps: [], decisions: [] }

export type Standing =
  | { kind: 'done' }
  | { kind: 'doing' }
  | { kind: 'ready' }
  | { kind: 'decision'; decisions: Decision[] }
  | { kind: 'step'; steps: Step[] }

/** Whatever was stored, made safe to draw: no dangling links, no step waiting on itself. */
export function tidy(raw: unknown): Roadmap {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Roadmap>
  const steps: Step[] = (Array.isArray(r.steps) ? r.steps : [])
    .filter((s): s is Step => !!s && typeof s.id === 'string' && typeof s.title === 'string')
    .map((s) => ({
      id: s.id,
      title: s.title,
      note: typeof s.note === 'string' && s.note ? s.note : undefined,
      owners: Array.isArray(s.owners) ? s.owners.filter((o) => typeof o === 'string' && o) : [],
      undecided: s.undecided === true || undefined,
      after: Array.isArray(s.after) ? s.after.filter((a) => typeof a === 'string') : [],
      state: s.state === 'doing' || s.state === 'done' ? s.state : 'todo',
      due: typeof s.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.due) ? s.due : undefined,
    }))
  const ids = new Set(steps.map((s) => s.id))
  for (const s of steps) s.after = [...new Set(s.after)].filter((a) => a !== s.id && ids.has(a))
  // A loop (A waits on B waits on A) cannot be drawn left to right, and means
  // nothing anyway: the link that closes it is dropped.
  for (const s of steps) s.after = s.after.filter((a) => !reaches(steps, a, s.id))
  const decisions: Decision[] = (Array.isArray(r.decisions) ? r.decisions : [])
    .filter((d): d is Decision => !!d && typeof d.id === 'string' && typeof d.question === 'string')
    .map((d) => ({
      id: d.id,
      question: d.question,
      owner: typeof d.owner === 'string' && d.owner ? d.owner : undefined,
      blocks: Array.isArray(d.blocks) ? [...new Set(d.blocks)].filter((b) => ids.has(b)) : [],
      answer: typeof d.answer === 'string' && d.answer.trim() ? d.answer : undefined,
    }))
  return { steps, decisions }
}

/** Whether `from` waits, however indirectly, on `target`. */
function reaches(steps: Step[], from: string, target: string, seen = new Set<string>()): boolean {
  if (from === target) return true
  if (seen.has(from)) return false
  seen.add(from)
  const step = steps.find((s) => s.id === from)
  return !!step && step.after.some((a) => reaches(steps, a, target, seen))
}

/** Whether making `step` wait on `on` would close a loop. */
export const wouldLoop = (road: Roadmap, step: string, on: string) => step === on || reaches(road.steps, on, step)

/**
 * Columns, left to right: a step sits one column after the last thing it waits
 * on, so reading across is reading the order, and steps in one column are the
 * ones that can run side by side.
 */
export function columns(road: Roadmap): Step[][] {
  const rank = new Map<string, number>()
  const rankOf = (s: Step, trail = new Set<string>()): number => {
    const known = rank.get(s.id)
    if (known !== undefined) return known
    if (trail.has(s.id)) return 0
    trail.add(s.id)
    const before = s.after.map((a) => road.steps.find((x) => x.id === a)).filter((x): x is Step => !!x)
    const r = before.length ? Math.max(...before.map((b) => rankOf(b, trail))) + 1 : 0
    rank.set(s.id, r)
    return r
  }
  const out: Step[][] = []
  for (const s of road.steps) (out[rankOf(s)] ??= []).push(s)
  return out.filter(Boolean)
}

/** Where a step stands, and why. A decision outranks a step as the reason:
 *  it is the one a person can do something about today. */
export function standing(road: Roadmap, step: Step): Standing {
  if (step.state === 'done') return { kind: 'done' }
  const open = road.decisions.filter((d) => !d.answer && d.blocks.includes(step.id))
  if (open.length) return { kind: 'decision', decisions: open }
  const waiting = step.after.map((a) => road.steps.find((s) => s.id === a)).filter((s): s is Step => !!s && s.state !== 'done')
  if (waiting.length) return { kind: 'step', steps: waiting }
  return step.state === 'doing' ? { kind: 'doing' } : { kind: 'ready' }
}

/** The morning's answer: what can move, and who everything else is waiting for. */
export function summary(road: Roadmap) {
  const stands = road.steps.map((s) => ({ step: s, at: standing(road, s) }))
  const open = road.decisions.filter((d) => !d.answer)
  const waitingOn = new Map<string, number>()
  for (const d of open) if (d.owner) waitingOn.set(d.owner, (waitingOn.get(d.owner) ?? 0) + 1)
  return {
    ready: stands.filter((x) => x.at.kind === 'ready').map((x) => x.step),
    doing: stands.filter((x) => x.at.kind === 'doing').map((x) => x.step),
    done: stands.filter((x) => x.at.kind === 'done').length,
    stuckOnDecisions: stands.filter((x) => x.at.kind === 'decision').length,
    openDecisions: open,
    /** Who the open decisions are waiting for, most first. */
    deciders: [...waitingOn.entries()].sort((a, b) => b[1] - a[1]),
  }
}

// --- where things go ------------------------------------------------------------
//
// The map is laid out, not arranged by hand: a step's place IS its order, so
// letting somebody drag it elsewhere would let the picture say something the
// plan does not. Steps sit in their columns; a decision sits directly above the
// first step it holds, since that is the thing it is in the way of; and a
// decision that holds nothing yet waits in a row of its own underneath.

export const CARD_W = 264
export const CARD_H = 104
export const COL_GAP = 104
export const ROW_GAP = 44
export const GATE_H = 30
export const GATE_GAP = 10

export type Placed = {
  steps: { step: Step; x: number; y: number; n: number }[]
  decisions: { decision: Decision; x: number; y: number; loose: boolean }[]
}

export function layout(road: Roadmap, showSettled = false): Placed {
  const shown = road.decisions.filter((d) => showSettled || !d.answer)
  /* A decision belongs above the first step it holds, in the order steps are read. */
  const order = columns(road).flat().map((s) => s.id)
  const home = new Map<string, Decision[]>()
  const loose: Decision[] = []
  for (const d of shown) {
    const first = order.find((id) => d.blocks.includes(id))
    if (first) home.set(first, [...(home.get(first) ?? []), d])
    else loose.push(d)
  }
  const out: Placed = { steps: [], decisions: [] }
  const cols = columns(road)
  const number = new Map(cols.flat().map((s, i) => [s.id, i + 1]))
  /* Row by row, so the cards of a row stand on one line: every row is given the
     room its tallest stack of decisions needs, whichever column that is in. */
  let y = 0
  let bottom = 0
  for (let r = 0; r < Math.max(0, ...cols.map((c) => c.length)); r++) {
    const room = Math.max(0, ...cols.map((c) => (c[r] ? (home.get(c[r].id) ?? []).length : 0))) * (GATE_H + GATE_GAP)
    cols.forEach((col, c) => {
      const step = col[r]
      if (!step) return
      const x = c * (CARD_W + COL_GAP)
      const gates = home.get(step.id) ?? []
      gates.forEach((decision, k) => out.decisions.push({ decision, x, y: y + room - (gates.length - k) * (GATE_H + GATE_GAP), loose: false }))
      out.steps.push({ step, x, y: y + room, n: number.get(step.id)! })
    })
    y += room + CARD_H + ROW_GAP
    bottom = y
  }
  loose.forEach((decision, i) => out.decisions.push({ decision, x: i * (CARD_W + 24), y: bottom + 12, loose: true }))
  return out
}

export const newId = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 9)}`
