import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { CARD_H, CARD_W, COL_GAP, GATE_GAP, GATE_H, columns, layout, standing, summary, tidy, wouldLoop, type Roadmap } from './model'

const road: Roadmap = tidy({
  steps: [
    { id: 'brand', title: 'Brand the app', owners: ['sam'], after: [], state: 'todo' },
    { id: 'crew', title: 'Crew functionality', owners: ['Alex'], after: ['brand'], state: 'todo' },
    { id: 'crew2', title: 'Crew-side functionality', owners: ['sam'], after: ['brand'], state: 'todo' },
    { id: 'home', title: 'Homeowner design', owners: ['sam'], after: ['crew'], state: 'todo' },
    { id: 'homefn', title: 'Homeowner functionality', owners: ['sam', 'Alex'], undecided: true, after: ['home'], state: 'todo' },
    { id: 'funnel', title: 'Funnel', owners: [], after: ['homefn'], state: 'todo' },
  ],
  decisions: [
    { id: 'd1', question: 'What does signed off mean for branding?', owner: 'sam', blocks: ['crew'] },
    { id: 'd2', question: 'Who takes homeowner functionality?', owner: 'sam', blocks: ['homefn'] },
  ],
})

test('reading across is reading the order, and one column is what can run side by side', () => {
  const cols = columns(road).map((c) => c.map((s) => s.id))
  assert.deepEqual(cols, [['brand'], ['crew', 'crew2'], ['home'], ['homefn'], ['funnel']])
})

test('a step says why it cannot start, and a decision is the reason given first', () => {
  const at = (id: string) => standing(road, road.steps.find((s) => s.id === id)!)
  assert.equal(at('brand').kind, 'ready')
  const crew = at('crew')
  assert.equal(crew.kind, 'decision', 'it waits on the brand too, but the decision is what somebody can act on')
  assert.equal(crew.kind === 'decision' && crew.decisions[0].id, 'd1')
  assert.equal(at('crew2').kind, 'step')
  assert.equal(at('funnel').kind, 'step')
})

test('settling a decision and finishing a step each move the work behind them', () => {
  const next = tidy({ ...road, steps: road.steps.map((s) => (s.id === 'brand' ? { ...s, state: 'done' } : s)), decisions: road.decisions.map((d) => (d.id === 'd1' ? { ...d, answer: 'Tokens and mark applied on every screen.' } : d)) })
  const at = (id: string) => standing(next, next.steps.find((s) => s.id === id)!).kind
  assert.equal(at('brand'), 'done')
  assert.equal(at('crew'), 'ready')
  assert.equal(at('crew2'), 'ready')
  const s = summary(next)
  assert.deepEqual(s.ready.map((x) => x.id), ['crew', 'crew2'])
  assert.deepEqual(s.deciders, [['sam', 1]])
})

test('the summary is the morning answer: what can start, and who the rest waits for', () => {
  const s = summary(road)
  assert.deepEqual(s.ready.map((x) => x.id), ['brand'])
  assert.equal(s.openDecisions.length, 2)
  assert.deepEqual(s.deciders, [['sam', 2]])
})

test('what was stored is made safe to draw', () => {
  const messy = tidy({
    steps: [
      { id: 'a', title: 'A', owners: 'nobody', after: ['a', 'ghost', 'b'], state: 'later', due: 'soon' },
      { id: 'b', title: 'B', owners: [], after: ['a'], state: 'doing', due: '2026-10-01' },
      { title: 'no id' },
    ],
    decisions: [{ id: 'd', question: 'Q', blocks: ['ghost', 'a', 'a'], answer: '  ' }, { question: 'no id' }],
  })
  assert.equal(messy.steps.length, 2)
  assert.deepEqual(messy.steps[0].owners, [])
  assert.equal(messy.steps[0].state, 'todo')
  assert.equal(messy.steps[0].due, undefined)
  assert.equal(messy.steps[1].due, '2026-10-01')
  // a waits on b and b on a: one of the two links is dropped, so it can be drawn
  const loops = messy.steps[0].after.includes('b') && messy.steps[1].after.includes('a')
  assert.equal(loops, false)
  assert.deepEqual(messy.decisions[0].blocks, ['a'])
  assert.equal(messy.decisions[0].answer, undefined)
  assert.equal(tidy(null).steps.length, 0)
})

test('a link that would close a loop is refused before it is made', () => {
  assert.equal(wouldLoop(road, 'brand', 'funnel'), true, 'the funnel already waits on the brand, five steps back')
  assert.equal(wouldLoop(road, 'funnel', 'brand'), false)
  assert.equal(wouldLoop(road, 'crew', 'crew'), true)
})

test('a decision sits above the step it is in the way of, and one that holds nothing waits underneath', () => {
  const withLoose = tidy({ ...road, decisions: [...road.decisions, { id: 'd3', question: 'What does Jo own?', blocks: [] }] })
  const placed = layout(withLoose)
  const step = (id: string) => placed.steps.find((p) => p.step.id === id)!
  const gate = (id: string) => placed.decisions.find((p) => p.decision.id === id)!
  assert.equal(step('brand').x, 0)
  assert.equal(step('crew').x, CARD_W + COL_GAP)
  assert.equal(gate('d1').x, step('crew').x, 'in the column of the step it holds')
  assert.equal(gate('d1').y + GATE_H + GATE_GAP, step('crew').y, 'and directly above it')
  assert.ok(step('crew2').y >= step('crew').y + CARD_H, 'the step beside it is pushed down, not overlapped')
  assert.equal(step('brand').y, step('crew').y, 'a row stands on one line, whichever of its cards has a decision over it')
  assert.equal(step('home').y, step('funnel').y)
  assert.equal(gate('d3').loose, true)
  assert.ok(gate('d3').y > Math.max(...placed.steps.map((p) => p.y + CARD_H)), 'under everything')
  assert.deepEqual(['brand', 'crew', 'crew2', 'home', 'homefn', 'funnel'].map((id) => step(id).n), [1, 2, 3, 4, 5, 6], 'numbered in the order they are read: down a column, then across')
})

test('a settled decision leaves the map unless it is asked for', () => {
  const settled = tidy({ ...road, decisions: road.decisions.map((d) => (d.id === 'd1' ? { ...d, answer: 'Done means reviewed.' } : d)) })
  assert.equal(layout(settled).decisions.some((p) => p.decision.id === 'd1'), false)
  assert.equal(layout(settled, true).decisions.some((p) => p.decision.id === 'd1'), true)
  /* A row keeps the room while any card in it still has a decision over it;
     with the last of them settled, the whole row moves up. */
  const all = tidy({ ...road, decisions: road.decisions.map((d) => ({ ...d, answer: 'Settled.' })) })
  const crew = (placed: ReturnType<typeof layout>) => placed.steps.find((p) => p.step.id === 'crew')!.y
  assert.equal(crew(layout(settled)), crew(layout(settled, true)), 'one decision left in the row: the row stays put')
  assert.ok(crew(layout(all)) < crew(layout(all, true)), 'none left: it gives the room back')
})
