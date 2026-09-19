// /api/v2: the four base tabs (Board, Docs, Canvas, Meetings), members and
// workspace settings, answered the same way whatever the workspace lives in.
//
// Two stores sit behind it:
//   SqlStore         a local folder (PGlite) or Supabase, via the shared `db`
//   CloudflareStore  D1 behind the workspace's Worker, via its HTTP API
// The UI never knows which. Every response uses the shapes below.

import { Hono } from 'hono'
import { db } from './db'
import { currentWeek, listWeeks, localToday, endsOn as weekEnds, type Week as WeekRow } from './weeks'
import { formatRef, prefixFor } from '../src/lib/ref'
import { CloudflareWorkspace, CloudflareError } from './cloudflare-workspace'
import { markdownToTiptap, tiptapToMarkdown } from './tiptap'
import type { Workspace } from './workspaces'
import { unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import * as audio from './audio'
import { transcribe } from './ai-local'
import { summarize, hasLocalChat, teamContext, type Summary } from './ai'
import { localKey } from './keys'
import { parakeetAvailable } from './parakeet'
import { runComposio } from './composio'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appHome } from './home'
import { toneOf } from '../src/v2/canvas/tone'

// --- shapes -----------------------------------------------------------------

export type Status = 'todo' | 'progress' | 'review' | 'done'
export const STATUSES: Status[] = ['todo', 'progress', 'review', 'done']
export type Person = { id: string; name: string; email: string | null; avatar: string | null; role: string }
export type Card = {
  id: string
  ref: string
  title: string
  body: string
  status: Status
  assignee: Person | null
  labels: string[]
  position: number
  updatedAt: string
  /** Monday of the card's week (YYYY-MM-DD), or null for the backlog. */
  week: string | null
}
export type CycleInfo = { start: string; end: string; label: string; total: number; done: number; current: boolean; past: boolean }
export type CyclesView = { current: string; cycles: CycleInfo[]; backlog: number; settings: Cycles; next: string }
export type WeekRef = string | 'backlog'
export type DocSummary = { id: string; title: string; folder: string | null; updatedAt: string; excerpt: string }
export type Doc = DocSummary & { body: string; revision: number }
export type CanvasSummary = { id: string; title: string; updatedAt: string; nodeCount: number; thumb: string | null }
export type Canvas = { id: string; title: string; revision: number; nodes: unknown[]; edges: unknown[] }
export type MeetingSummary = { id: string; title: string; startedAt: string; durationS: number | null; hasTranscript: boolean; status: string }
export type Meeting = MeetingSummary & { notes: string; transcript: string | null; revision: number }
/** The four tabs every workspace can have. Any other type belongs to a pack: an add-on the app loads if it has it. */
export const BASE_TAB_TYPES = ['board', 'docs', 'canvas', 'meetings'] as const
export type TabDef = { id: string; type: string; name: string; hidden?: boolean; columns?: string[] }

/** Checks a tabs list someone wants to save; returns what is wrong, or null. */
export function tabsProblem(tabs: unknown): string | null {
  if (!Array.isArray(tabs) || !tabs.length) return 'Tabs must be a list with at least one tab.'
  const ids = new Set<string>()
  for (const t of tabs as any[]) {
    if (!t || typeof t.id !== 'string' || !t.id || typeof t.name !== 'string' || !t.name) return 'Every tab needs an id and a name.'
    if (typeof t.type !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(t.type)) return `Tab "${t.name}" needs a type: board, docs, canvas, meetings, or a pack's type.`
    if (ids.has(t.id)) return `Two tabs share the id "${t.id}".`
    ids.add(t.id)
    if (t.columns !== undefined && (!Array.isArray(t.columns) || !t.columns.every((c: unknown) => typeof c === 'string'))) return `Tab "${t.name}": columns must be a list of names.`
  }
  return null
}

/** Pack data keys: "marketing.inspiration", "management.team". */
export const PACK_KEY = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/
export type Cycles = { length: 1 | 2 | 4; rollover: 'ask' | 'next' | 'backlog'; upcoming: number; since?: string }
export const DEFAULT_CYCLES: Cycles = { length: 1, rollover: 'ask', upcoming: 1 }
export type Settings = { name?: string; logo?: string | null; tabs: TabDef[]; cycles?: Cycles }

export const DEFAULT_TABS: TabDef[] = [
  { id: 'board', type: 'board', name: 'Board', columns: ['Todo', 'In progress', 'Review', 'Done'] },
  { id: 'docs', type: 'docs', name: 'Docs' },
  { id: 'canvas', type: 'canvas', name: 'Canvas' },
  { id: 'meetings', type: 'meetings', name: 'Meetings' },
]

export interface Store {
  kind: string
  settings(): Promise<Settings>
  saveSettings(s: Partial<Settings>): Promise<Settings>
  members(): Promise<Person[]>
  invite(email: string, role: string): Promise<{ link: string | null }>
  setRole(id: string, role: string): Promise<void>
  setAvatar(id: string, dataUrl: string): Promise<void>
  /** Card counts per week (by Monday), the backlog, and where the board's weeks begin. */
  tally(): Promise<{ weeks: Map<string, { total: number; done: number }>; backlog: number; anchor: string | null; numbers: Map<string, number> }>
  /** Cards in any of these weeks, or in the backlog. */
  cardsIn(weeks: string[] | 'backlog'): Promise<Card[]>
  /** Move cards to a week (its Monday) or to the backlog (null). */
  moveCards(ids: string[], week: string | null): Promise<void>
  createCard(c: { title: string; status?: Status; week?: WeekRef }): Promise<Card>
  updateCard(id: string, patch: Partial<{ title: string; body: string; status: Status; assigneeId: string | null; position: number; week: WeekRef }>): Promise<Card>
  deleteCard(id: string): Promise<void>
  docs(): Promise<DocSummary[]>
  doc(id: string): Promise<Doc>
  createDoc(title: string, body?: string): Promise<Doc>
  saveDoc(id: string, d: { title: string; body: string; revision: number }): Promise<Doc>
  canvases(): Promise<CanvasSummary[]>
  canvas(id: string): Promise<Canvas>
  createCanvas(title: string): Promise<Canvas>
  saveCanvas(id: string, c: Canvas): Promise<Canvas>
  meetings(): Promise<MeetingSummary[]>
  meeting(id: string): Promise<Meeting>
  createMeeting(m: { title: string; transcript?: string; notes?: string; startedAt?: string; durationS?: number }): Promise<Meeting>
  saveMeeting(id: string, m: { title: string; notes: string; revision: number }): Promise<Meeting>
  remove(kind: 'docs' | 'canvases' | 'meetings', id: string): Promise<void>
  /** Data a pack keeps in this workspace (a library, a list), or null if it has none. */
  pack(key: string): Promise<{ value: unknown; updatedAt: string } | null>
  setPack(key: string, value: unknown): Promise<void>
  packKeys(): Promise<{ key: string; updatedAt: string; bytes: number }[]>
}

// --- canvas thumbnails: the board itself, drawn small --------------------------

/** An SVG of the board: every object as its outline and colour, arrows as lines. */
export function thumbnail(nodes: any[], edges: any[] = []): string | null {
  const boxes = nodes
    .map((n) => {
      const w = Number(n.style?.width ?? n.width ?? n.measured?.width ?? 160)
      const h = Number(n.style?.height ?? n.height ?? n.measured?.height ?? 90)
      return { id: n.id, type: n.type, x: n.position?.x ?? 0, y: n.position?.y ?? 0, w: w || 160, h: h || 90, data: n.data ?? {} }
    })
    .filter((b) => Number.isFinite(b.x) && Number.isFinite(b.y))
  if (!boxes.length) return null
  const minX = Math.min(...boxes.map((b) => b.x)), minY = Math.min(...boxes.map((b) => b.y))
  const maxX = Math.max(...boxes.map((b) => b.x + b.w)), maxY = Math.max(...boxes.map((b) => b.y + b.h))
  const W = maxX - minX || 1, H = maxY - minY || 1
  const pad = Math.max(W, H) * 0.04
  const at = new Map(boxes.map((b) => [b.id, b]))
  const r = (v: number) => Math.round(v)
  const out: string[] = []
  const stroke = Math.max(W, H) / 300
  for (const b of boxes.filter((b) => b.type === 'section')) {
    out.push(`<rect x="${r(b.x)}" y="${r(b.y)}" width="${r(b.w)}" height="${r(b.h)}" fill="#171717" stroke="#303030" stroke-width="${stroke}"/>`)
  }
  for (const e of edges) {
    const a = at.get(e.source), c = at.get(e.target)
    if (!a || !c) continue
    out.push(`<line x1="${r(a.x + a.w)}" y1="${r(a.y + a.h / 2)}" x2="${r(c.x)}" y2="${r(c.y + c.h / 2)}" stroke="#5a5a5a" stroke-width="${stroke}"/>`)
  }
  for (const b of boxes.filter((b) => b.type !== 'section')) {
    if (b.type === 'text') {
      out.push(`<rect x="${r(b.x)}" y="${r(b.y + b.h * 0.35)}" width="${r(b.w * 0.7)}" height="${r(Math.max(b.h * 0.3, stroke * 2))}" rx="${stroke}" fill="#4a4a4a"/>`)
      continue
    }
    const t = b.type === 'image' ? { line: '#6b6b6b', fill: 'rgba(160,160,160,0.18)' } : toneOf(b.data)
    out.push(`<rect x="${r(b.x)}" y="${r(b.y)}" width="${r(b.w)}" height="${r(b.h)}" rx="${r(Math.min(b.w, b.h) * 0.08)}" fill="${t.fill.replace('0.08', '0.28')}" stroke="${t.line}" stroke-width="${stroke * 1.4}"/>`)
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${r(minX - pad)} ${r(minY - pad)} ${r(W + pad * 2)} ${r(H + pad * 2)}" preserveAspectRatio="xMidYMid meet">${out.join('')}</svg>`
}

/** Thumbnails for boards that live elsewhere, kept on this Mac by board and edit time. */
const THUMBS = join(appHome(), 'cache', 'canvas-thumbs.json')
let thumbCache: Record<string, string | null> | null = null
function thumbStore() {
  if (!thumbCache) {
    try {
      thumbCache = existsSync(THUMBS) ? JSON.parse(readFileSync(THUMBS, 'utf8')) : {}
    } catch {
      thumbCache = {}
    }
  }
  return thumbCache!
}
function saveThumbs() {
  try {
    mkdirSync(dirname(THUMBS), { recursive: true })
    writeFileSync(THUMBS, JSON.stringify(thumbCache))
  } catch {}
}

export class Conflict extends Error {
  status = 409
}

/** ISO week number of a Monday. */
export function isoWeekOf(monday: string) {
  const d = new Date(`${monday}T00:00:00`)
  d.setDate(d.getDate() + 3)
  const jan4 = new Date(d.getFullYear(), 0, 4)
  return 1 + Math.round(((d.getTime() - jan4.getTime()) / 86400000 - 3 + ((jan4.getDay() + 6) % 7)) / 7)
}

/** Monday of the week containing a date, as YYYY-MM-DD in local time. */
export function mondayOf(d: string | Date = new Date()): string {
  const x = typeof d === 'string' ? new Date(d.length === 10 ? `${d}T00:00:00` : d) : new Date(d)
  const back = (x.getDay() + 6) % 7
  x.setDate(x.getDate() - back)
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
}
export function addDays(ymd: string, n: number) {
  const x = new Date(`${ymd}T00:00:00`)
  x.setDate(x.getDate() + n)
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
}

const excerpt = (md: string) =>
  md.replace(/[#>*_`\-\[\]!()]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140)

// --- SQL store: local folders and Supabase ---------------------------------

const COLUMN_FOR: Record<Status, string[]> = {
  todo: ['Backlog', 'Todo', 'To do'],
  progress: ['In Progress', 'In progress'],
  review: ['In Review', 'Review'],
  done: ['Done'],
}

async function q<T = any>(p: PromiseLike<{ data: any; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p
  if (error) throw new Error(error.message)
  return data as T
}

class SqlStore implements Store {
  kind = 'sql'
  constructor(private ws: Workspace) {}

  private prefix() {
    return this.ws.prefix ?? prefixFor(this.ws.name)
  }

  async settings(): Promise<Settings> {
    const rows = await q<{ key: string; value: any }[]>(db.from('workspace_settings').select('*'))
    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]))
    return { name: map.brand?.name ?? this.ws.name, logo: map.brand?.logo ?? null, tabs: map.tabs ?? DEFAULT_TABS, cycles: { ...DEFAULT_CYCLES, ...(map.cycles ?? {}) } }
  }
  async saveSettings(s: Partial<Settings>) {
    const cur = await this.settings()
    if (s.tabs) await q(db.from('workspace_settings').upsert({ key: 'tabs', value: s.tabs, updated_at: new Date().toISOString() }))
    if (s.cycles) await q(db.from('workspace_settings').upsert({ key: 'cycles', value: s.cycles, updated_at: new Date().toISOString() }))
    if (s.name !== undefined || s.logo !== undefined) {
      await q(
        db.from('workspace_settings').upsert({
          key: 'brand',
          value: { name: s.name ?? cur.name, logo: s.logo !== undefined ? s.logo : cur.logo },
          updated_at: new Date().toISOString(),
        }),
      )
    }
    return this.settings()
  }

  async members(): Promise<Person[]> {
    const rows = await q<any[]>(db.from('people').select('*').eq('active', true).order('position'))
    return rows.map((p) => ({ id: p.id, name: p.name, email: p.email ?? null, avatar: p.avatar_url ?? null, role: p.role ?? 'member' }))
  }
  async invite(email: string, role: string) {
    const name = email.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
    await q(db.from('people').insert({ name, email, role, position: Date.now() / 1e12 }))
    return { link: null }
  }
  async setRole(id: string, role: string) {
    await q(db.from('people').update({ role }).eq('id', id))
  }
  async setAvatar(id: string, dataUrl: string) {
    await q(db.from('people').update({ avatar_url: dataUrl }).eq('id', id))
  }

  private async columns() {
    return q<{ id: string; name: string; position: number }[]>(db.from('columns').select('*').order('position'))
  }
  private statusOf(colName: string): Status {
    for (const s of STATUSES) if (COLUMN_FOR[s].some((n) => n.toLowerCase() === colName.toLowerCase())) return s
    return 'todo'
  }
  private async columnFor(status: Status) {
    const cols = await this.columns()
    return cols.find((c) => COLUMN_FOR[status].some((n) => n.toLowerCase() === c.name.toLowerCase())) ?? cols[0]
  }
  private shape(r: any, cols: Map<string, string>, people: Map<string, Person>, weeks: Map<string, string> = new Map()): Card {
    return {
      week: r.week_id ? (weeks.get(r.week_id) ?? null) : null,
      id: r.id,
      ref: formatRef(r.number, this.prefix()),
      title: r.title,
      body: r.body ?? '',
      status: this.statusOf(cols.get(r.column_id) ?? ''),
      assignee: r.assignee_id ? (people.get(r.assignee_id) ?? null) : null,
      labels: r.labels ?? [],
      position: r.position,
      updatedAt: r.updated_at,
    }
  }
  private async lookups() {
    const [cols, people, weeks] = await Promise.all([this.columns(), this.members(), listWeeks()])
    return {
      cols: new Map(cols.map((c) => [c.id, c.name])),
      people: new Map(people.map((p) => [p.id, p])),
      weeks: new Map(weeks.map((w) => [w.id, mondayOf(w.starts_on)])),
    }
  }
  /** The week row for a Monday, adding weeks to the calendar as far as needed. */
  private async weekRow(monday: string): Promise<WeekRow> {
    let rows = await listWeeks()
    const find = () => rows.find((w) => mondayOf(w.starts_on) === monday)
    if (find()) return find()!
    if (!rows.length) {
      await q(db.from('weeks').insert({ number: 1, starts_on: monday }))
      rows = await listWeeks()
      return find()!
    }
    let last = rows[rows.length - 1]
    if (monday < mondayOf(rows[0].starts_on)) throw new Error('That week is before this board began.')
    while (mondayOf(last.starts_on) < monday) {
      last = await q<WeekRow>(db.from('weeks').insert({ number: last.number + 1, starts_on: addDays(mondayOf(last.starts_on), 7) }).select('*').single())
    }
    rows = await listWeeks()
    const hit = find()
    if (!hit) throw new Error(`No week starting ${monday} on this board.`)
    return hit
  }
  async tally() {
    const [rows, cards, cols] = await Promise.all([
      listWeeks(),
      q<{ week_id: string | null; column_id: string }[]>(db.from('cards').select('week_id, column_id').is('archived_at', null)),
      this.columns(),
    ])
    const doneCols = new Set(cols.filter((c) => this.statusOf(c.name) === 'done').map((c) => c.id))
    const monday = new Map(rows.map((w) => [w.id, mondayOf(w.starts_on)]))
    const weeks = new Map<string, { total: number; done: number }>()
    let backlog = 0
    for (const c of cards) {
      const m = c.week_id ? monday.get(c.week_id) : null
      if (!m) {
        backlog++
        continue
      }
      const t = weeks.get(m) ?? { total: 0, done: 0 }
      t.total++
      if (doneCols.has(c.column_id)) t.done++
      weeks.set(m, t)
    }
    return { weeks, backlog, anchor: rows.length ? mondayOf(rows[0].starts_on) : null, numbers: new Map(rows.map((w) => [mondayOf(w.starts_on), w.number])) }
  }
  async cardsIn(weeks: string[] | 'backlog') {
    let query = db.from('cards').select('*').is('archived_at', null).order('position')
    if (weeks === 'backlog') query = query.is('week_id', null)
    else {
      const rows = (await listWeeks()).filter((w) => weeks.includes(mondayOf(w.starts_on)))
      if (!rows.length) return []
      query = query.in('week_id', rows.map((w) => w.id))
    }
    const [rows, { cols, people, weeks: wk }] = await Promise.all([q<any[]>(query), this.lookups()])
    return rows.map((r) => this.shape(r, cols, people, wk))
  }
  async moveCards(ids: string[], week: string | null) {
    if (!ids.length) return
    const w = week ? await this.weekRow(week) : null
    await q(db.from('cards').update({ week_id: w?.id ?? null }).in('id', ids))
  }
  private async one(id: string) {
    const [row, { cols, people, weeks }] = await Promise.all([q<any>(db.from('cards').select('*').eq('id', id).single()), this.lookups()])
    return this.shape(row, cols, people, weeks)
  }
  async createCard(c: { title: string; status?: Status; week?: WeekRef }) {
    const col = await this.columnFor(c.status ?? 'todo')
    const w = c.week === 'backlog' ? null : await this.weekRow(c.week ?? mondayOf(localToday()))
    const row = await q<any>(
      db.from('cards').insert({ title: c.title, column_id: col.id, position: Date.now() / 1e6, week_id: w?.id ?? null }).select('*').single(),
    )
    return this.one(row.id)
  }
  async updateCard(id: string, p: Partial<{ title: string; body: string; status: Status; assigneeId: string | null; position: number; week: WeekRef }>) {
    const patch: Record<string, unknown> = {}
    if (p.week !== undefined) patch.week_id = p.week === 'backlog' ? null : (await this.weekRow(p.week)).id
    if (p.title !== undefined) patch.title = p.title
    if (p.body !== undefined) patch.body = p.body
    if (p.assigneeId !== undefined) patch.assignee_id = p.assigneeId
    if (p.position !== undefined) patch.position = p.position
    if (p.status) patch.column_id = (await this.columnFor(p.status)).id
    if (Object.keys(patch).length) await q(db.from('cards').update(patch).eq('id', id))
    return this.one(id)
  }
  async deleteCard(id: string) {
    await q(db.from('cards').update({ archived_at: new Date().toISOString() }).eq('id', id))
  }

  async docs() {
    const rows = await q<any[]>(db.from('docs').select('*').order('updated_at', { ascending: false }))
    return rows.map((d) => ({ id: d.id, title: d.title, folder: d.tags?.[0] ?? null, updatedAt: d.updated_at, excerpt: excerpt(d.body ?? '') }))
  }
  async doc(id: string): Promise<Doc> {
    const d = await q<any>(db.from('docs').select('*').eq('id', id).single())
    return { id: d.id, title: d.title, folder: d.tags?.[0] ?? null, updatedAt: d.updated_at, excerpt: excerpt(d.body ?? ''), body: d.body ?? '', revision: Date.parse(d.updated_at) }
  }
  async createDoc(title: string, body = '') {
    const slug = `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'doc'}-${Date.now().toString(36)}`
    const d = await q<any>(db.from('docs').insert({ title, slug, body }).select('*').single())
    return this.doc(d.id)
  }
  async saveDoc(id: string, d: { title: string; body: string; revision: number }) {
    const cur = await this.doc(id)
    if (d.revision && cur.revision !== d.revision) throw new Conflict('Someone else changed this doc. Reload to see their version.')
    await q(db.from('docs').update({ title: d.title, body: d.body }).eq('id', id))
    return this.doc(id)
  }

  async canvases() {
    const rows = await q<any[]>(db.from('canvases').select('*').is('archived_at', null).order('updated_at', { ascending: false }))
    return rows.map((c) => ({ id: c.id, title: c.title, updatedAt: c.updated_at, nodeCount: c.content?.nodes?.length ?? 0, thumb: thumbnail(c.content?.nodes ?? [], c.content?.edges ?? []) }))
  }
  async canvas(id: string): Promise<Canvas> {
    const c = await q<any>(db.from('canvases').select('*').eq('id', id).single())
    return { id: c.id, title: c.title, revision: c.revision, nodes: c.content?.nodes ?? [], edges: c.content?.edges ?? [] }
  }
  async createCanvas(title: string) {
    const c = await q<any>(db.from('canvases').insert({ title, content: { nodes: [], edges: [] } }).select('*').single())
    return this.canvas(c.id)
  }
  async saveCanvas(id: string, c: Canvas) {
    const cur = await this.canvas(id)
    if (cur.revision !== c.revision) throw new Conflict('This canvas changed elsewhere. Reload before editing.')
    await q(
      db
        .from('canvases')
        .update({ title: c.title, content: { nodes: c.nodes, edges: c.edges }, revision: cur.revision + 1, updated_at: new Date().toISOString() })
        .eq('id', id),
    )
    return this.canvas(id)
  }

  async meetings() {
    const rows = await q<any[]>(db.from('meetings').select('*, transcripts(meeting_id)').order('started_at', { ascending: false }).limit(200))
    return rows.map((m) => ({
      id: m.id,
      title: m.title,
      startedAt: m.started_at,
      durationS: m.duration_s ?? null,
      hasTranscript: !!m.transcripts,
      status: m.status,
    }))
  }
  async meeting(id: string): Promise<Meeting> {
    const m = await q<any>(db.from('meetings').select('*, transcripts(*), summaries(*)').eq('id', id).single())
    const s = m.summaries
    let notes = m.raw_notes ?? ''
    if (!notes && s) {
      const lines = [`## Summary`, s.tldr]
      if (s.decisions?.length) lines.push('', '## Decisions', ...s.decisions.map((d: any) => `- ${typeof d === 'string' ? d : (d.text ?? d.decision ?? JSON.stringify(d))}`))
      if (s.action_items?.length)
        lines.push('', '## Action items', ...s.action_items.map((a: any) => `- [ ] ${typeof a === 'string' ? a : (a.text ?? a.title ?? JSON.stringify(a))}`))
      notes = lines.join('\n')
    }
    return {
      id: m.id,
      title: m.title,
      startedAt: m.started_at,
      durationS: m.duration_s ?? null,
      hasTranscript: !!m.transcripts,
      status: m.status,
      notes,
      transcript: m.transcripts?.text ?? null,
      revision: Date.parse(m.last_seen_at ?? m.created_at),
    }
  }
  async createMeeting(m: { title: string; transcript?: string; notes?: string; startedAt?: string; durationS?: number }) {
    const row = await q<any>(
      db
        .from('meetings')
        .insert({
          title: m.title,
          started_at: m.startedAt ?? new Date().toISOString(),
          duration_s: m.durationS ?? null,
          raw_notes: m.notes ?? null,
          source: 'recorded',
          status: m.transcript ? 'transcribed' : 'recorded',
        })
        .select('*')
        .single(),
    )
    if (m.transcript) await q(db.from('transcripts').insert({ meeting_id: row.id, text: m.transcript, engine: 'parakeet' }))
    return this.meeting(row.id)
  }
  async saveMeeting(id: string, m: { title: string; notes: string; revision: number }) {
    await q(db.from('meetings').update({ title: m.title, raw_notes: m.notes, last_seen_at: new Date().toISOString() }).eq('id', id))
    return this.meeting(id)
  }
  async remove(kind: 'docs' | 'canvases' | 'meetings', id: string) {
    if (kind === 'canvases') await q(db.from('canvases').update({ archived_at: new Date().toISOString() }).eq('id', id))
    else await q(db.from(kind).delete().eq('id', id))
  }

  async pack(key: string) {
    const rows = await q<any[]>(db.from('pack_data').select('value, updated_at').eq('key', key).limit(1))
    return rows[0] ? { value: rows[0].value, updatedAt: rows[0].updated_at } : null
  }
  async setPack(key: string, value: unknown) {
    await q(db.from('pack_data').upsert({ key, value, updated_at: new Date().toISOString() }))
  }
  async packKeys() {
    const rows = await q<any[]>(db.from('pack_data').select('key, updated_at, value'))
    return rows.map((r) => ({ key: r.key, updatedAt: r.updated_at, bytes: JSON.stringify(r.value).length })).sort((a, b) => a.key.localeCompare(b.key))
  }
}

// --- Cloudflare store ---------------------------------------------------------

const SETTINGS_TITLE = '.alfredo'
/** Each pack's data is its own hidden document, so a big library never slows the settings down. */
const PACK_PREFIX = '.alfredo/pack/'
const hidden = (title: string) => title === SETTINGS_TITLE || title?.startsWith(PACK_PREFIX)

class CloudflareStore implements Store {
  kind = 'cloudflare'
  constructor(private ws: Workspace, private api: CloudflareWorkspace) {}

  private prefix() {
    return this.ws.prefix ?? prefixFor(this.ws.name)
  }
  private items(): Promise<any[]> {
    return this.api.call('/items')
  }
  private async settingsItem() {
    return (await this.items()).find((i) => i.type === 'document' && i.title === SETTINGS_TITLE) ?? null
  }

  /** Everything Alfredo keeps for this workspace: brand, tabs, avatars. */
  private async raw(): Promise<Record<string, any>> {
    const item = await this.settingsItem()
    if (!item) return {}
    const full = await this.api.call(`/items/${item.id}`)
    return full.content?.alfredo ?? {}
  }
  private async writeRaw(next: Record<string, any>) {
    const item = await this.settingsItem()
    // The settings ride along in the content of one hidden document, next to
    // an empty doc so the Worker's own editor still opens it cleanly.
    const content = { doc: { type: 'doc', content: [{ type: 'paragraph' }] }, alfredo: next }
    if (!item) await this.api.call('/items', { method: 'POST', body: { type: 'document', title: SETTINGS_TITLE, content } })
    else {
      const full = await this.api.call(`/items/${item.id}`)
      await this.api.call(`/items/${item.id}`, { method: 'PUT', body: { title: SETTINGS_TITLE, content, revision: full.revision } })
    }
  }

  async settings(): Promise<Settings> {
    const s = await this.raw()
    return { name: s.name ?? this.ws.name, logo: s.logo ?? null, tabs: s.tabs ?? DEFAULT_TABS, cycles: { ...DEFAULT_CYCLES, ...(s.cycles ?? {}) } }
  }
  async saveSettings(patch: Partial<Settings>) {
    const cur = await this.raw()
    const next = { ...cur }
    if (patch.name !== undefined) next.name = patch.name
    if (patch.logo !== undefined) next.logo = patch.logo
    if (patch.tabs !== undefined) next.tabs = patch.tabs
    if (patch.cycles !== undefined) next.cycles = patch.cycles
    await this.writeRaw(next)
    return this.settings()
  }

  async members(): Promise<Person[]> {
    const [rows, s] = await Promise.all([this.api.call<any[]>('/members'), this.raw()])
    const avatars = s.avatars ?? {}
    return rows.map((m) => ({ id: m.id, name: m.name, email: m.email, avatar: avatars[m.id] ?? null, role: m.role === 'owner' ? 'admin' : m.role }))
  }
  async invite(email: string, role: string) {
    const r = await this.api.call<{ token: string | null }>('/invites', { method: 'POST', body: { email, role: role === 'admin' ? 'editor' : role } })
    // Some Workers run their own sign-up page; Alfredo's own Worker adds people directly.
    return { link: r.token ? `${this.api.url}/?invite=${r.token}` : null }
  }
  async setRole() {
    throw new Error('Roles for this workspace are changed in its Cloudflare dashboard for now.')
  }
  async setAvatar(id: string, dataUrl: string) {
    const cur = await this.raw()
    await this.writeRaw({ ...cur, avatars: { ...(cur.avatars ?? {}), [id]: dataUrl } })
  }

  /** Which week each task sits in. Worker tasks have no week of their own, so
   *  Alfredo keeps the map in its settings; a task it has never placed sits in
   *  the week it was created. */
  private weekOf(t: any, map: Record<string, string>): string | null {
    const w = map[t.id]
    if (w === 'backlog') return null
    return w ?? mondayOf(t.created_at)
  }
  private async placeWeeks(patch: Record<string, string>) {
    const cur = await this.raw()
    await this.writeRaw({ ...cur, taskWeeks: { ...(cur.taskWeeks ?? {}), ...patch } })
  }

  private shape(t: any, people: Person[], i: number, map: Record<string, string> = {}): Card {
    const a = t.assignee ? (people.find((p) => p.id === t.assignee || p.email === t.assignee || p.name === t.assignee) ?? { id: t.assignee, name: t.assignee, email: null, avatar: null, role: 'member' }) : null
    return {
      id: t.id,
      ref: `${this.prefix()}-${t.id.slice(0, 4).toUpperCase()}`,
      title: t.title,
      body: t.description ?? '',
      status: STATUSES.includes(t.status) ? t.status : 'todo',
      assignee: a,
      labels: [t.priority].filter((p) => p && p !== 'medium'),
      position: i,
      updatedAt: t.updated_at,
      week: this.weekOf(t, map),
      // Cloudflare tasks carry a revision; the client sends it back on save.
      ...({ revision: t.revision } as any),
    }
  }
  async tally() {
    const [rows, st] = await Promise.all([this.api.call<any[]>('/tasks'), this.raw()])
    const map = st.taskWeeks ?? {}
    const weeks = new Map<string, { total: number; done: number }>()
    let backlog = 0
    for (const t of rows) {
      const w = this.weekOf(t, map)
      if (!w) {
        backlog++
        continue
      }
      const x = weeks.get(w) ?? { total: 0, done: 0 }
      x.total++
      if (t.status === 'done') x.done++
      weeks.set(w, x)
    }
    const all = [...weeks.keys()].sort()
    return { weeks, backlog, anchor: st.cycles?.anchor ?? all[0] ?? null, numbers: new Map<string, number>() }
  }
  async cardsIn(weeks: string[] | 'backlog') {
    const [rows, people, st] = await Promise.all([this.api.call<any[]>('/tasks'), this.members(), this.raw()])
    const map = st.taskWeeks ?? {}
    return rows
      .map((t, i) => this.shape(t, people, i, map))
      .filter((c) => (weeks === 'backlog' ? c.week === null : c.week !== null && weeks.includes(c.week)))
  }
  async moveCards(ids: string[], week: string | null) {
    if (ids.length) await this.placeWeeks(Object.fromEntries(ids.map((id) => [id, week ?? 'backlog'])))
  }
  async createCard(c: { title: string; status?: Status; week?: WeekRef }) {
    const t = await this.api.call('/tasks', { method: 'POST', body: { title: c.title, status: c.status ?? 'todo' } })
    const week = c.week ?? mondayOf(localToday())
    if (week !== mondayOf(t.created_at)) await this.placeWeeks({ [t.id]: week })
    return this.shape(t, await this.members(), 0, { [t.id]: week })
  }
  async updateCard(id: string, p: Partial<{ title: string; body: string; status: Status; assigneeId: string | null; week: WeekRef }>) {
    if (p.week !== undefined) await this.placeWeeks({ [id]: p.week })
    const cur = (await this.api.call<any[]>('/tasks')).find((t) => t.id === id)
    if (!cur) throw new CloudflareError('Card not found.', 404)
    const t = await this.api.call(`/tasks/${id}`, {
      method: 'PUT',
      body: {
        title: p.title ?? cur.title,
        description: p.body ?? cur.description,
        status: p.status ?? cur.status,
        priority: cur.priority,
        assignee: p.assigneeId !== undefined ? (p.assigneeId ?? '') : cur.assignee,
        due_date: cur.due_date,
        linked_item: cur.linked_item,
        revision: cur.revision,
      },
    })
    return this.shape(t, await this.members(), 0, (await this.raw()).taskWeeks ?? {})
  }
  async deleteCard(id: string) {
    await this.api.call(`/tasks/${id}`, { method: 'DELETE' })
  }

  async docs() {
    const items = (await this.items()).filter((i) => i.type === 'document' && !hidden(i.title))
    return items.map((i) => ({ id: i.id, title: i.title, folder: null, updatedAt: i.updated_at, excerpt: '' }))
  }
  async doc(id: string): Promise<Doc> {
    const i = await this.api.call(`/items/${id}`)
    const body = tiptapToMarkdown(i.content?.doc)
    return { id: i.id, title: i.title, folder: null, updatedAt: i.updated_at, excerpt: excerpt(body), body, revision: i.revision }
  }
  async createDoc(title: string, body = '') {
    const i = await this.api.call('/items', { method: 'POST', body: { type: 'document', title, content: { doc: markdownToTiptap(body) } } })
    return this.doc(i.id)
  }
  async saveDoc(id: string, d: { title: string; body: string; revision: number }) {
    const cur = await this.api.call(`/items/${id}`)
    try {
      await this.api.call(`/items/${id}`, {
        method: 'PUT',
        body: { title: d.title, content: { ...cur.content, doc: markdownToTiptap(d.body) }, revision: d.revision },
      })
    } catch (e) {
      if (e instanceof CloudflareError && e.status === 409) throw new Conflict(e.message)
      throw e
    }
    return this.doc(id)
  }

  async canvases() {
    const items = (await this.items()).filter((i) => i.type === 'board')
    const cache = thumbStore()
    let dirty = false
    const out = await Promise.all(
      items.map(async (i) => {
        const key = `${this.api.url}|${i.id}|${i.updated_at}`
        if (!(key in cache)) {
          const b = await this.api.call(`/items/${i.id}/board`).catch(() => null)
          cache[key] = b ? thumbnail(b.nodes ?? [], b.edges ?? []) : null
          dirty = true
        }
        return { id: i.id, title: i.title, updatedAt: i.updated_at, nodeCount: 0, thumb: cache[key] }
      }),
    )
    if (dirty) saveThumbs()
    return out
  }
  async canvas(id: string): Promise<Canvas> {
    const [meta, board] = await Promise.all([this.api.call(`/items/${id}`), this.api.call(`/items/${id}/board`)])
    return { id, title: board.title || meta.title, revision: board.revision ?? 1, nodes: board.nodes ?? [], edges: board.edges ?? [] }
  }
  async createCanvas(title: string) {
    const i = await this.api.call('/items', { method: 'POST', body: { type: 'board', title } })
    return this.canvas(i.id)
  }
  async saveCanvas(id: string, c: Canvas) {
    const cur = await this.api.call(`/items/${id}/board`)
    try {
      await this.api.call(`/items/${id}/board`, {
        method: 'PUT',
        body: { ...cur, title: c.title, nodes: c.nodes, edges: c.edges, revision: c.revision },
      })
    } catch (e) {
      if (e instanceof CloudflareError && e.status === 409) throw new Conflict(e.message)
      throw e
    }
    return this.canvas(id)
  }

  async meetings() {
    const items = (await this.items()).filter((i) => i.type === 'meeting')
    return items.map((i) => ({ id: i.id, title: i.title, startedAt: i.created_at, durationS: null, hasTranscript: false, status: 'recorded' }))
  }
  async meeting(id: string): Promise<Meeting> {
    const i = await this.api.call(`/items/${id}`)
    return {
      id: i.id,
      title: i.title,
      startedAt: i.content?.startedAt ?? i.created_at,
      durationS: i.content?.durationS ?? null,
      hasTranscript: !!i.content?.transcript,
      status: 'recorded',
      notes: tiptapToMarkdown(i.content?.doc),
      transcript: i.content?.transcript ?? null,
      revision: i.revision,
    }
  }
  async createMeeting(m: { title: string; transcript?: string; notes?: string; startedAt?: string; durationS?: number }) {
    const i = await this.api.call('/items', {
      method: 'POST',
      body: {
        type: 'meeting',
        title: m.title,
        content: { doc: markdownToTiptap(m.notes ?? ''), transcript: m.transcript ?? null, startedAt: m.startedAt, durationS: m.durationS },
      },
    })
    return this.meeting(i.id)
  }
  async saveMeeting(id: string, m: { title: string; notes: string; revision: number }) {
    const cur = await this.api.call(`/items/${id}`)
    await this.api.call(`/items/${id}`, {
      method: 'PUT',
      body: { title: m.title, content: { ...cur.content, doc: markdownToTiptap(m.notes) }, revision: m.revision },
    })
    return this.meeting(id)
  }
  async remove(_kind: 'docs' | 'canvases' | 'meetings', id: string) {
    // The Worker archives rather than deletes; its own board stays protected.
    await this.api.call(`/items/${id}`, { method: 'DELETE' })
  }

  private async packItem(key: string) {
    return (await this.items()).find((i) => i.type === 'document' && i.title === PACK_PREFIX + key) ?? null
  }
  async pack(key: string) {
    const item = await this.packItem(key)
    if (!item) return null
    const full = await this.api.call(`/items/${item.id}`)
    return { value: full.content?.pack ?? null, updatedAt: full.updatedAt ?? full.updated_at ?? '' }
  }
  async setPack(key: string, value: unknown) {
    const item = await this.packItem(key)
    const content = { doc: { type: 'doc', content: [{ type: 'paragraph' }] }, pack: value }
    if (!item) await this.api.call('/items', { method: 'POST', body: { type: 'document', title: PACK_PREFIX + key, content } })
    else {
      const full = await this.api.call(`/items/${item.id}`)
      await this.api.call(`/items/${item.id}`, { method: 'PUT', body: { title: PACK_PREFIX + key, content, revision: full.revision } })
    }
  }
  async packKeys() {
    const items = (await this.items()).filter((i) => i.type === 'document' && i.title?.startsWith(PACK_PREFIX))
    return items.map((i) => ({ key: i.title.slice(PACK_PREFIX.length), updatedAt: i.updatedAt ?? i.updated_at ?? '', bytes: 0 }))
  }
}

/** The store behind a workspace: its folder, Supabase, or its Cloudflare Worker. */
export function storeFor(c: { workspace: Workspace; db: unknown } | undefined): Store {
  if (!c) throw new Error('no workspace')
  if (c.workspace.kind === 'cloudflare') {
    if (!(c.db instanceof CloudflareWorkspace)) throw new Error('This workspace has lost its Cloudflare token. Reconnect it in Settings > Database.')
    return new CloudflareStore(c.workspace, c.db)
  }
  return new SqlStore(c.workspace)
}

// --- transcription: transcript only, the audio never outlives it -------------

type Job = { id: string; title: string; state: 'recording' | 'transcribing' | 'writing' | 'done' | 'failed'; meetingId?: string; error?: string; startedAt: number }
const jobs = new Map<string, Job>()
let install: { state: 'idle' | 'running' | 'done' | 'failed'; log: string; startedAt?: number } = { state: 'idle', log: '' }

/** The write-up as Markdown notes: what the meeting page shows and edits. */
export function notesFrom(s: Summary): string {
  const out: string[] = ['## Summary', s.tldr]
  for (const sec of s.sections ?? []) out.push('', `## ${sec.heading}`, ...sec.bullets.map((b) => `- ${b}`))
  if (s.decisions?.length) out.push('', '## Decisions', ...s.decisions.map((d) => `- ${d.what}${d.why ? ` (${d.why})` : ''}`))
  if (s.action_items?.length)
    out.push('', '## Action items', ...s.action_items.map((a) => `- [ ] ${a.title}${a.assignee ? ` @${a.assignee}` : ''}${a.due ? ` (due ${a.due})` : ''}`))
  if (s.open_questions?.length) out.push('', '## Open questions', ...s.open_questions.map((q) => `- ${q.question}`))
  return out.join('\n')
}

async function finish(job: Job, st: Store, path: string, durationS: number, startedAt: number) {
  try {
    job.state = 'transcribing'
    const t = await transcribe(path)
    if (!t.text.trim()) throw new Error('No speech was heard. Check Microphone (and Screen Recording) access for Alfredo in System Settings.')
    job.state = 'writing'
    let notes = ''
    let title = job.title
    try {
      const [set, people] = await Promise.all([st.settings(), st.members()]).catch(() => [null, []] as const)
      const s = await summarize(hasLocalChat() ? '' : localKey(), t.text, undefined, undefined, teamContext(set?.name, people.map((p) => p.name)))
      notes = notesFrom(s)
      if ((!title || title === 'Meeting') && s.title?.trim()) title = s.title.trim()
    } catch (e) {
      notes = `_The write-up could not be generated: ${(e as Error).message}_`
    }
    const m = await st.createMeeting({ title: title || 'Meeting', transcript: t.text, notes, startedAt: new Date(startedAt).toISOString(), durationS: Math.round(durationS) })
    job.meetingId = m.id
    job.state = 'done'
  } catch (e) {
    job.state = 'failed'
    job.error = (e as Error).message
  } finally {
    // The audio exists only long enough to be transcribed.
    await unlink(path).catch(() => {})
  }
}

// --- routes -------------------------------------------------------------------

export function v2Routes(current: () => { workspace: Workspace; db: unknown } | undefined) {
  const app = new Hono()

  const store = () => storeFor(current())

  app.onError((e, c) => {
    const status = (e as any).status ?? (e instanceof Conflict ? 409 : 500)
    return c.json({ error: e.message }, status)
  })

  app.get('/settings', async (c) => c.json(await store().settings()))
  app.put('/settings', async (c) => {
    const b = await c.req.json<Partial<Settings>>()
    if (b.tabs !== undefined) {
      const problem = tabsProblem(b.tabs)
      if (problem) return c.json({ error: problem }, 400)
    }
    if (b.cycles) {
      const cur = (await store().settings()).cycles ?? DEFAULT_CYCLES
      const length = [1, 2, 4].includes(Number(b.cycles.length)) ? (Number(b.cycles.length) as 1 | 2 | 4) : cur.length
      const rollover = ['ask', 'next', 'backlog'].includes(b.cycles.rollover as string) ? b.cycles.rollover! : cur.rollover
      // Automatic rollover applies from now on, never retroactively to old weeks.
      const since = rollover === 'ask' ? undefined : cur.rollover === 'ask' || !cur.since ? mondayOf(localToday()) : cur.since
      b.cycles = { length, rollover, upcoming: Math.max(0, Math.min(6, Number(b.cycles.upcoming ?? cur.upcoming))), ...(since ? { since } : {}) }
    }
    return c.json(await store().saveSettings(b))
  })

  app.get('/packs', async (c) => c.json(await store().packKeys()))
  app.get('/packs/:key', async (c) => {
    const key = c.req.param('key')
    if (!PACK_KEY.test(key)) return c.json({ error: 'Bad pack key.' }, 400)
    const p = await store().pack(key)
    if (!p) return c.json({ error: `This workspace has no "${key}" data yet.` }, 404)
    // A library changes rarely; let the browser revalidate instead of refetching megabytes.
    const etag = `"${key}:${p.updatedAt}"`
    if (c.req.header('if-none-match') === etag) return c.body(null, 304)
    c.header('etag', etag)
    c.header('cache-control', 'no-cache')
    return c.json(p.value)
  })
  app.put('/packs/:key', async (c) => {
    const key = c.req.param('key')
    if (!PACK_KEY.test(key)) return c.json({ error: 'Bad pack key.' }, 400)
    await store().setPack(key, await c.req.json())
    return c.json({ ok: true })
  })

  app.get('/members', async (c) => c.json(await store().members()))
  app.post('/members/invite', async (c) => {
    const b = await c.req.json<{ email: string; role?: string }>()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email ?? '')) return c.json({ error: 'Enter a valid email.' }, 400)
    return c.json(await store().invite(b.email.trim().toLowerCase(), b.role === 'admin' ? 'admin' : 'member'))
  })
  app.patch('/members/:id', async (c) => {
    const b = await c.req.json<{ role?: string; avatar?: string }>()
    if (b.role) await store().setRole(c.req.param('id'), b.role === 'admin' ? 'admin' : 'member')
    if (b.avatar) {
      if (!/^data:image\/(png|jpeg|webp);base64,/.test(b.avatar) || b.avatar.length > 400_000) {
        return c.json({ error: 'Use a PNG, JPEG or WebP under 300 KB.' }, 400)
      }
      await store().setAvatar(c.req.param('id'), b.avatar)
    }
    return c.json({ ok: true })
  })

  const weekParam = (w: string | undefined) => (w === 'backlog' ? 'backlog' : w && /^\d{4}-\d{2}-\d{2}$/.test(w) ? mondayOf(w) : undefined)

  /** Cycles: runs of `length` weeks counted from the board's first week. */
  function cycleMath(anchor: string, len: number) {
    const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000)
    const startOf = (monday: string) => addDays(anchor, Math.floor(days(anchor, monday) / (7 * len)) * 7 * len)
    const weeksOf = (start: string) => Array.from({ length: len }, (_, i) => addDays(start, 7 * i))
    const index = (start: string) => Math.floor(days(anchor, start) / (7 * len)) + 1
    return { startOf, weeksOf, index, next: (start: string) => addDays(start, 7 * len) }
  }

  async function cycles(): Promise<CyclesView> {
    const st = store()
    const [settings, t] = await Promise.all([st.settings(), st.tally()])
    const cfg = { ...DEFAULT_CYCLES, ...(settings.cycles ?? {}) }
    const today = mondayOf(localToday())
    const anchor = t.anchor && t.anchor <= today ? t.anchor : today
    const m = cycleMath(anchor, cfg.length)
    const current = m.startOf(today)

    // Roll unfinished work out of cycles that ended since the setting was turned on.
    if (cfg.rollover !== 'ask' && cfg.since) {
      const ended = [...t.weeks.keys()].filter((w) => w >= cfg.since! && m.startOf(w) < current)
      if (ended.length) {
        const open = (await st.cardsIn(ended)).filter((c) => c.status !== 'done').map((c) => c.id)
        if (open.length) {
          await st.moveCards(open, cfg.rollover === 'next' ? current : null)
          return cycles()
        }
      }
    }

    const starts = new Set<string>()
    for (const [w, n] of t.weeks) if (n.total) starts.add(m.startOf(w))
    starts.add(current)
    for (let i = 1, s = current; i <= cfg.upcoming; i++) starts.add((s = m.next(s)))
    const list = [...starts].sort().map((start) => {
      const tally = m.weeksOf(start).reduce((a, w) => ({ total: a.total + (t.weeks.get(w)?.total ?? 0), done: a.done + (t.weeks.get(w)?.done ?? 0) }), { total: 0, done: 0 })
      const num = cfg.length === 1 ? (t.numbers.get(start) ?? isoWeekOf(start)) : m.index(start)
      return {
        start,
        end: addDays(start, 7 * cfg.length - 1),
        label: cfg.length === 1 ? `Week ${num}` : `Cycle ${num}`,
        ...tally,
        current: start === current,
        past: start < current,
      }
    })
    return { current, cycles: list, backlog: t.backlog, settings: cfg, next: m.next(current) }
  }

  app.get('/weeks', async (c) => c.json(await cycles()))
  /** Finish a cycle: its unfinished cards go to the next cycle or the backlog. */
  app.post('/weeks/complete', async (c) => {
    const b = await c.req.json<{ start: string; to: 'next' | 'backlog' }>()
    const start = weekParam(b.start)
    if (!start || start === 'backlog') return c.json({ error: 'Pick a cycle.' }, 400)
    const st = store()
    const view = await cycles()
    const m = cycleMath((await st.tally()).anchor ?? start, view.settings.length)
    const open = (await st.cardsIn(m.weeksOf(start))).filter((x) => x.status !== 'done').map((x) => x.id)
    await st.moveCards(open, b.to === 'backlog' ? null : m.next(start))
    return c.json({ moved: open.length })
  })
  app.get('/cards', async (c) => {
    const w = weekParam(c.req.query('week'))
    if (w === 'backlog') return c.json(await store().cardsIn('backlog'))
    const view = await cycles()
    const st = store()
    const start = w ?? view.current
    const m = cycleMath((await st.tally()).anchor ?? start, view.settings.length)
    return c.json(await st.cardsIn(m.weeksOf(m.startOf(start))))
  })
  app.post('/cards', async (c) => {
    const b = await c.req.json<{ title: string; status?: Status; week?: string }>()
    if (!b.title?.trim()) return c.json({ error: 'Give the card a title.' }, 400)
    return c.json(await store().createCard({ title: b.title.trim(), status: STATUSES.includes(b.status!) ? b.status : 'todo', week: weekParam(b.week) }))
  })
  app.patch('/cards/:id', async (c) => {
    const b = await c.req.json<Record<string, any>>()
    if (b.week !== undefined) b.week = weekParam(b.week) ?? 'backlog'
    return c.json(await store().updateCard(c.req.param('id'), b))
  })
  app.delete('/cards/:id', async (c) => {
    await store().deleteCard(c.req.param('id'))
    return c.json({ ok: true })
  })

  app.get('/docs', async (c) => c.json(await store().docs()))
  app.get('/docs/:id', async (c) => c.json(await store().doc(c.req.param('id'))))
  app.post('/docs', async (c) => {
    const b = await c.req.json<{ title?: string; body?: string }>()
    return c.json(await store().createDoc(b.title?.trim() || 'Untitled', b.body ?? ''))
  })
  app.put('/docs/:id', async (c) => c.json(await store().saveDoc(c.req.param('id'), await c.req.json())))

  app.get('/canvases', async (c) => c.json(await store().canvases()))
  app.get('/canvases/:id', async (c) => c.json(await store().canvas(c.req.param('id'))))
  app.post('/canvases', async (c) => {
    const b = await c.req.json<{ title?: string }>()
    return c.json(await store().createCanvas(b.title?.trim() || 'Untitled canvas'))
  })
  app.put('/canvases/:id', async (c) => c.json(await store().saveCanvas(c.req.param('id'), await c.req.json())))

  app.get('/meetings', async (c) => c.json(await store().meetings()))
  app.get('/meetings/:id', async (c) => c.json(await store().meeting(c.req.param('id'))))
  app.post('/meetings', async (c) => {
    const b = await c.req.json<{ title?: string; transcript?: string; notes?: string; startedAt?: string; durationS?: number }>()
    return c.json(await store().createMeeting({ ...b, title: b.title?.trim() || 'Meeting' }))
  })
  app.put('/meetings/:id', async (c) => c.json(await store().saveMeeting(c.req.param('id'), await c.req.json())))

  for (const kind of ['docs', 'canvases', 'meetings'] as const) {
    app.delete(`/${kind}/:id`, async (c) => {
      await store().remove(kind, c.req.param('id'))
      return c.json({ ok: true })
    })
  }

  app.get('/transcribe/engine', (c) => c.json({ parakeet: parakeetAvailable(), recording: audio.isRecording(), install }))
  /* Parakeet, downloaded and built once on this Mac. The script ships with
   * the app; it needs Xcode's command line tools. */
  app.post('/transcribe/install', (c) => {
    if (parakeetAvailable()) return c.json({ ok: true, install })
    if (install.state === 'running') return c.json({ ok: true, install })
    const here = dirname(fileURLToPath(import.meta.url))
    const script = [join(here, '..', 'scripts', 'build-parakeet.sh'), join(process.cwd(), 'scripts', 'build-parakeet.sh')].find((p) => existsSync(p))
    if (!script) return c.json({ error: 'The Parakeet setup script is missing from this build.' }, 500)
    install = { state: 'running', log: '', startedAt: Date.now() }
    const p = spawn(process.env.SHELL || '/bin/zsh', ['-lc', `sh "${script}"`], { env: { ...process.env, ALFREDO_HOME: appHome() } })
    const add = (d: Buffer) => (install.log = (install.log + d.toString()).slice(-4000))
    p.stdout.on('data', add)
    p.stderr.on('data', add)
    p.on('close', (code) => {
      install.state = code === 0 && parakeetAvailable() ? 'done' : 'failed'
    })
    return c.json({ ok: true, install })
  })
  app.post('/transcribe/start', async (c) => {
    if (audio.isRecording()) return c.json({ error: 'Already transcribing a meeting.' }, 409)
    const b = await c.req.json<{ title?: string; micOnly?: boolean }>().catch(() => ({}) as { title?: string; micOnly?: boolean })
    const id = randomUUID()
    const r = audio.start(id, !!b.micOnly)
    jobs.set(id, { id, title: b.title?.trim() || 'Meeting', state: 'recording', startedAt: r.startedAt })
    return c.json({ id, startedAt: r.startedAt })
  })
  app.post('/transcribe/stop', async (c) => {
    const st = store()
    const b = await c.req.json<{ title?: string }>().catch(() => ({}) as { title?: string })
    const r = await audio.stop()
    const job = jobs.get(r.id) ?? { id: r.id, title: 'Meeting', state: 'recording' as const, startedAt: Date.now() - r.durationS * 1000 }
    if (b.title?.trim()) job.title = b.title.trim()
    jobs.set(r.id, job)
    finish(job, st, r.path, r.durationS, job.startedAt)
    return c.json({ id: r.id, systemAudio: r.systemAudio })
  })
  app.get('/transcribe/:id', (c) => {
    const j = jobs.get(c.req.param('id'))
    return j ? c.json(j) : c.json({ error: 'unknown job' }, 404)
  })

  /* Upcoming meetings from Google Calendar, through Composio. Uses this
   * workspace's chosen calendar account when one is set. */
  app.get('/calendar/upcoming', async (c) => {
    const cur = current()
    const alias = cur?.workspace.composio?.googlecalendar
    const args = [
      'execute',
      'GOOGLECALENDAR_EVENTS_LIST',
      '-d',
      JSON.stringify({ calendarId: 'primary', timeMin: new Date().toISOString(), maxResults: 6, singleEvents: true, orderBy: 'startTime' }),
      ...(alias ? ['--account', alias] : []),
    ]
    const { out } = await runComposio(args, 30_000)
    const start = out.indexOf('{')
    let r: any = null
    try {
      r = start >= 0 ? JSON.parse(out.slice(start, out.lastIndexOf('}') + 1)) : null
    } catch {}
    if (!r?.successful) {
      const missing = /No active connection|link googlecalendar/i.test(r?.error ?? out)
      return c.json({ connected: !missing, events: [], error: missing ? null : (r?.error ?? 'Calendar unavailable') })
    }
    const items = r.data?.items ?? r.data?.response_data?.items ?? []
    return c.json({
      connected: true,
      events: items.map((e: any) => ({
        id: e.id,
        title: e.summary ?? '(no title)',
        start: e.start?.dateTime ?? e.start?.date,
        end: e.end?.dateTime ?? e.end?.date,
        link: e.hangoutLink ?? e.location ?? null,
        people: (e.attendees ?? []).length,
      })),
    })
  })

  app.get('/asset', async (c) => {
    const cur = current()
    const src = c.req.query('src') ?? ''
    if (!cur || cur.workspace.kind !== 'cloudflare' || !(cur.db instanceof CloudflareWorkspace)) return c.json({ error: 'not found' }, 404)
    if (!/^\/assets\/[\w./-]+$/.test(src) || src.includes('..')) return c.json({ error: 'bad path' }, 400)
    const res = await cur.db.raw(src)
    return new Response(res.body, { status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? 'application/octet-stream', 'cache-control': 'private, max-age=3600' } })
  })

  return app
}
