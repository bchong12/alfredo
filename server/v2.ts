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
import type { Shelf } from './chunk-shelf'
import { toVector } from './vector'
import { theMachine } from './v2-machine'
import { inviteLink } from './invite-link'
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
export type Settings = { name?: string; logo?: string | null; tabs: TabDef[]; cycles?: Cycles; projects?: { enabled: boolean } }

/**
 * Projects split one workspace (and its one database) into separate boards,
 * docs, canvases and meetings. Off by default. Which project an item belongs
 * to is a mapping kept beside the items, so it works the same on every
 * database and never changes the items themselves.
 */
/** What someone may do inside a project. Workspace admins are 'admin' everywhere. */
export type ProjectRole = 'admin' | 'write' | 'read'
export const PROJECT_ROLES: ProjectRole[] = ['admin', 'write', 'read']
export type ProjectMember = { personId: string; role: ProjectRole }
export type Project = {
  id: string
  name: string
  color: string
  archived?: boolean
  /** Everyone listed here is in the project; workspace admins are in every one. */
  members: ProjectMember[]
  /** Set when the database decided this itself, and then it is the answer. */
  role?: ProjectRole | null
}
/** An invitation to join the workspace, and the projects it puts someone in. */
export type Invite = {
  id: string
  email: string
  role: 'admin' | 'member'
  projects: { id: string; role: ProjectRole }[]
  createdAt: string
  expiresAt: string
  usedAt?: string | null
}
export type ItemKind = 'card' | 'doc' | 'canvas' | 'meeting'
/** One piece of the workspace's writing, and the vector of it. */
export type ChunkRow = { ord: number; title: string; heading: string; text: string; embedding: number[] }
/** What a search found, and where it came from. */
export type Hit = { kind: ItemKind; itemId: string; ord: number; title: string; heading: string; text: string; score: number }
/** Who is asking: their row in this workspace's people, and whether they run it. */
export type Viewer = { id: string | null; admin: boolean }

/** What someone may do in a project: their role, or null when they are not in it. */
export function projectRole(p: Project, me: Viewer): ProjectRole | null {
  // A database that decides for itself (a Worker) says so in the project.
  if (p.role !== undefined) return p.role
  if (me.admin) return 'admin'
  return (me.id ? p.members.find((m) => m.personId === me.id)?.role : null) ?? null
}
export const canOpenProject = (p: Project, me: Viewer) => projectRole(p, me) !== null
/** Read-only members may open a project but not change anything in it. */
export const canWriteProject = (p: Project, me: Viewer) => {
  const r = projectRole(p, me)
  return r === 'admin' || r === 'write'
}
export const ITEM_KINDS: ItemKind[] = ['card', 'doc', 'canvas', 'meeting']
/** Asking for the work that belongs to no project at all. */
export const NO_PROJECT = 'none'
export const PROJECT_COLORS = ['slate', 'blue', 'green', 'amber', 'rose', 'violet', 'teal', 'orange']

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
  /** Counts for the board. `only` keeps the cards it says yes to. */
  tally(only?: ((id: string) => boolean) | null): Promise<{ weeks: Map<string, { total: number; done: number }>; backlog: number; anchor: string | null; numbers: Map<string, number> }>
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
  /** Who the database says is asking, where it keeps its own people. */
  viewer?(): Promise<Viewer | null>
  /** What the workspace knows, in a form a question can reach. */
  putChunks(kind: ItemKind, itemId: string, rows: ChunkRow[]): Promise<void>
  dropChunks(kind: ItemKind, itemId: string): Promise<void>
  searchChunks(q: { vector: number[]; text: string; limit: number }): Promise<Hit[]>
  chunkCount(): Promise<number>
  projects(): Promise<Project[]>
  saveProjects(list: Project[]): Promise<void>
  /** Pending and spent invitations. */
  invites(): Promise<Invite[]>
  createInvite(i: { email: string; role: 'admin' | 'member'; projects: { id: string; role: ProjectRole }[] }): Promise<{ invite: Invite; token: string }>
  revokeInvite(id: string): Promise<void>
  /** The invitation a token opens, if it is still good. */
  inviteFor(token: string): Promise<Invite | null>
  /** Spend an invitation: the person joins, with the projects it names. */
  acceptInvite(token: string, person: { name: string; email: string; userId?: string | null }): Promise<Person>
  /** "kind:id" -> project id, for every item that belongs to one. */
  projectMap(): Promise<Record<string, string>>
  /** Put items in a project, or take them out of any (null). */
  assign(kind: ItemKind, ids: string[], project: string | null): Promise<void>
}

// --- invitations ---------------------------------------------------------------

/** The secret in an invite link. Only its hash is stored. */
/* The Web Crypto both Node and a hosted function have, rather than Node's own:
   this file has to run in both. Same bytes out either way, so a token hashed
   by the desktop app is found by the site and the other way round. */
export const inviteToken = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
export const hashToken = async (t: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t))), (b) => b.toString(16).padStart(2, '0')).join('')
const randomUUID = () => crypto.randomUUID()

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

/** Thumbnails for boards that live elsewhere, by board and edit time: kept on
 *  disk where there is one (see v2-desktop.ts), otherwise for as long as this runs. */
let thumbCache: Record<string, string | null> | null = null
function thumbStore() {
  if (!thumbCache) thumbCache = theMachine().thumbs.read()
  return thumbCache!
}
function saveThumbs() {
  if (thumbCache) theMachine().thumbs.write(thumbCache)
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

/* A store lives for one request, so what was learnt about a database has to
   outlive it: which workspaces keep their passages on this Mac, and which of a
   Worker's routes are not there. Forgotten after a while, so a table that gets
   created or a Worker that gets redeployed is noticed without a restart. */
const LEARNT_MS = 10 * 60_000
const learnt = new Map<string, number>()
const isLearnt = (key: string) => {
  const at = learnt.get(key)
  if (at && Date.now() - at < LEARNT_MS) return true
  if (at) learnt.delete(key)
  return false
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
    return {
      name: map.brand?.name ?? this.ws.name,
      logo: map.brand?.logo ?? null,
      tabs: map.tabs ?? DEFAULT_TABS,
      cycles: { ...DEFAULT_CYCLES, ...(map.cycles ?? {}) },
      projects: { enabled: !!map.project_settings?.enabled },
    }
  }
  async saveSettings(s: Partial<Settings>) {
    const cur = await this.settings()
    if (s.projects) await q(db.from('workspace_settings').upsert({ key: 'project_settings', value: { enabled: !!s.projects.enabled }, updated_at: new Date().toISOString() }))
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
  async tally(only: ((id: string) => boolean) | null = null) {
    const [rows, all, cols] = await Promise.all([
      listWeeks(),
      q<{ id: string; week_id: string | null; column_id: string }[]>(db.from('cards').select('id, week_id, column_id').is('archived_at', null)),
      this.columns(),
    ])
    const cards = only ? all.filter((c) => only(c.id)) : all
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

  /**
   * Passages belong in the database, beside the work. A database set up before
   * there were questions has no table for them ("Could not find the table
   * 'public.chunks'"), and running a migration on a team's database is not
   * something to do behind anyone's back: there they are kept on this Mac
   * until the table exists. See chunk-shelf.ts.
   */
  chunksOnThisMac = false
  private async shelved<T>(inDatabase: () => Promise<T>, onThisMac: (shelf: Shelf) => T): Promise<T> {
    const key = `shelf:${this.ws.id}`
    if (!isLearnt(key)) {
      try {
        return await inDatabase()
      } catch (e) {
        if (!/schema cache|does not exist|PGRST20[25]|42P01|42883/i.test((e as Error).message)) throw e
        learnt.set(key, Date.now())
      }
    }
    this.chunksOnThisMac = true
    return onThisMac(theMachine().shelfFor(this.ws.id))
  }
  async putChunks(kind: ItemKind, itemId: string, rows: ChunkRow[]) {
    await this.shelved(
      async () => {
        await q(db.from('chunks').delete().eq('kind', kind).eq('item_id', itemId))
        if (!rows.length) return
        await q(
          db.from('chunks').insert(
            rows.map((r) => ({
              kind,
              item_id: itemId,
              ord: r.ord,
              title: r.title,
              heading: r.heading,
              text: r.text,
              // PostgREST takes the vector as its own literal.
              embedding: toVector(r.embedding),
              updated_at: new Date().toISOString(),
            })),
          ),
        )
      },
      (shelf) => shelf.put(kind, itemId, rows),
    )
  }
  async dropChunks(kind: ItemKind, itemId: string) {
    await this.shelved(
      async () => void (await q(db.from('chunks').delete().eq('kind', kind).eq('item_id', itemId))),
      (shelf) => shelf.drop(kind, itemId),
    )
  }
  async searchChunks({ vector, text, limit }: { vector: number[]; text: string; limit: number }): Promise<Hit[]> {
    return this.shelved(
      async () => {
        const rows = await q<any[]>(db.rpc('alfredo_search', { q_embedding: toVector(vector), q_text: text, k: limit }))
        return (rows ?? []).map((r) => ({ kind: r.kind, itemId: r.item_id, ord: r.ord, title: r.title, heading: r.heading, text: r.text, score: Number(r.score) }) as Hit)
      },
      (shelf) => shelf.search({ vector, text, limit }),
    )
  }
  async chunkCount() {
    return this.shelved(
      async () => (await q<any[]>(db.from('chunks').select('id'))).length,
      (shelf) => shelf.count(),
    )
  }

  async projects(): Promise<Project[]> {
    const [rows, members] = await Promise.all([
      q<any[]>(db.from('projects').select('*').order('position')),
      q<any[]>(db.from('project_members').select('project_id, person_id, role')),
    ])
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      color: r.color,
      ...(r.archived_at ? { archived: true } : {}),
      members: members.filter((m) => m.project_id === r.id).map((m) => ({ personId: m.person_id, role: m.role as ProjectRole })),
    }))
  }
  async saveProjects(list: Project[]) {
    const before = await this.projects()
    for (const p of before) if (!list.some((x) => x.id === p.id)) await q(db.from('projects').delete().eq('id', p.id))
    for (const [i, p] of list.entries()) {
      await q(
        db.from('projects').upsert({ id: p.id, name: p.name, color: p.color, position: i, archived_at: p.archived ? new Date().toISOString() : null }),
      )
      await q(db.from('project_members').delete().eq('project_id', p.id))
      if (p.members.length) await q(db.from('project_members').insert(p.members.map((m) => ({ project_id: p.id, person_id: m.personId, role: m.role }))))
    }
  }

  private shapeInvite = (r: any): Invite => ({
    id: r.id,
    email: r.email,
    role: r.role,
    projects: r.projects ?? [],
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    usedAt: r.used_at ?? null,
  })
  async invites() {
    const rows = await q<any[]>(db.from('invites').select('*').order('created_at', { ascending: false }))
    return rows.map(this.shapeInvite)
  }
  async createInvite(i: { email: string; role: 'admin' | 'member'; projects: { id: string; role: ProjectRole }[] }) {
    const token = inviteToken()
    const expires = new Date(Date.now() + 14 * 86400000).toISOString()
    await q(db.from('invites').insert({ token_hash: (await hashToken(token)), email: i.email, role: i.role, projects: i.projects, expires_at: expires }))
    const rows = await q<any[]>(db.from('invites').select('*').eq('token_hash', (await hashToken(token))).limit(1))
    return { invite: this.shapeInvite(rows[0]), token }
  }
  async revokeInvite(id: string) {
    await q(db.from('invites').delete().eq('id', id))
  }
  async inviteFor(token: string) {
    const rows = await q<any[]>(db.from('invites').select('*').eq('token_hash', (await hashToken(token))).limit(1))
    const r = rows[0]
    if (!r || r.used_at || Date.parse(r.expires_at) < Date.now()) return null
    return this.shapeInvite(r)
  }
  async acceptInvite(token: string, person: { name: string; email: string; userId?: string | null }) {
    const invite = await this.inviteFor(token)
    if (!invite) throw new Error('This invitation is no longer good. Ask for a new one.')
    if (invite.email.toLowerCase() !== person.email.toLowerCase()) throw new Error('This invitation was sent to a different email.')
    const have = (await q<any[]>(db.from('people').select('*').ilike('email', person.email).limit(1)))[0]
    let row = have
    if (row) {
      await q(db.from('people').update({ role: invite.role, active: true, user_id: person.userId ?? row.user_id ?? null }).eq('id', row.id))
    } else {
      await q(db.from('people').insert({ name: person.name, email: person.email, role: invite.role, user_id: person.userId ?? null, position: Date.now() / 1e12 }))
      row = (await q<any[]>(db.from('people').select('*').ilike('email', person.email).limit(1)))[0]
    }
    for (const p of invite.projects) {
      await q(db.from('project_members').delete().eq('project_id', p.id).eq('person_id', row.id))
      await q(db.from('project_members').insert({ project_id: p.id, person_id: row.id, role: p.role }))
    }
    await q(db.from('invites').update({ used_at: new Date().toISOString() }).eq('id', invite.id))
    return { id: row.id, name: row.name, email: row.email ?? null, avatar: row.avatar_url ?? null, role: row.role ?? 'member' }
  }
  async projectMap() {
    const rows = await q<{ kind: string; item_id: string; project_id: string }[]>(db.from('project_items').select('kind, item_id, project_id'))
    return Object.fromEntries(rows.map((r) => [`${r.kind}:${r.item_id}`, r.project_id]))
  }
  async assign(kind: ItemKind, ids: string[], project: string | null) {
    if (!ids.length) return
    await q(db.from('project_items').delete().eq('kind', kind).in('item_id', ids))
    if (project) await q(db.from('project_items').insert(ids.map((id) => ({ kind, item_id: id, project_id: project }))))
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
    return { name: s.name ?? this.ws.name, logo: s.logo ?? null, tabs: s.tabs ?? DEFAULT_TABS, cycles: { ...DEFAULT_CYCLES, ...(s.cycles ?? {}) }, projects: { enabled: !!s.projectSettings?.enabled } }
  }
  async saveSettings(patch: Partial<Settings>) {
    const cur = await this.raw()
    const next = { ...cur }
    if (patch.name !== undefined) next.name = patch.name
    if (patch.logo !== undefined) next.logo = patch.logo
    if (patch.tabs !== undefined) next.tabs = patch.tabs
    if (patch.cycles !== undefined) next.cycles = patch.cycles
    if (patch.projects !== undefined) next.projectSettings = { enabled: !!patch.projects.enabled }
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
    // A team's own Worker may have its own sign-up page; Alfredo's Worker adds people directly.
    return { link: r.token ? `${this.api.url}/?invite=${r.token}` : null }
  }
  async setRole(id: string, role: string) {
    // The Worker's owner is Alfredo's admin; everyone else there edits.
    const live = await this.tryWorker<{ ok?: boolean }>(`/members/${id}`, { method: 'PATCH', body: { role: role === 'admin' ? 'owner' : 'editor' } })
    if (!live) throw new Error('The Worker behind this workspace cannot change roles yet. Redeploy it with the current cloudflare/worker.mjs.')
  }
  async setAvatar(id: string, dataUrl: string) {
    const cur = await this.raw()
    await this.writeRaw({ ...cur, avatars: { ...(cur.avatars ?? {}), [id]: dataUrl } })
  }

  /** Which week each task sits in. A task there has no week of its own, so
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
  async tally(only: ((id: string) => boolean) | null = null) {
    const [tasks, st] = await Promise.all([this.api.call<any[]>('/tasks'), this.raw()])
    const rows = only ? tasks.filter((t) => only(t.id)) : tasks
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

  /**
   * Alfredo's own Worker keeps projects, memberships and invitations in D1 and
   * decides access there. An older Worker has none of that, so those
   * calls come back 404 and the settings document stands in, with this Mac
   * doing the deciding.
   */
  /**
   * A 404 is remembered against the ROUTE, not against the Worker. Workers in
   * the wild are of every age: one has projects but not questions, the next
   * the other way round. Taking the first 404 to mean the whole Worker is old
   * switched off everything else it could do, which is how a workspace ends up
   * reading itself in over and over and staying empty.
   */
  private async tryWorker<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T | null> {
    /* An id in the path is not part of the route. */
    const route = `gone:${this.ws.id}:${init?.method ?? 'GET'} ${path.replace(/\/[^/]{8,}$/, '/:id')}`
    if (isLearnt(route)) return null
    try {
      return await this.api.call<T>(path, init)
    } catch (e) {
      if (e instanceof CloudflareError && e.status === 404) {
        learnt.set(route, Date.now())
        return null
      }
      throw e
    }
  }

  /**
   * Passages live in the database when it has somewhere for them. A Worker
   * older than questions are has not, and is not always ours to redeploy (a
   * team's own, serving everybody else as it stands): there they are kept on
   * this Mac instead, which is where they were made and the only place they
   * are asked about. See chunk-shelf.ts.
   */
  chunksOnThisMac = false
  private shelf() {
    this.chunksOnThisMac = true
    return theMachine().shelfFor(this.ws.id)
  }
  async putChunks(kind: ItemKind, itemId: string, rows: ChunkRow[]) {
    const live = await this.tryWorker('/chunks', {
      method: 'PUT',
      body: { kind, itemId, chunks: rows.map((r) => ({ ...r, embedding: Array.from(r.embedding) })) },
    })
    if (!live) this.shelf().put(kind, itemId, rows)
  }
  async dropChunks(kind: ItemKind, itemId: string) {
    const live = await this.tryWorker('/chunks', { method: 'DELETE', body: { kind, itemId } })
    if (!live) this.shelf().drop(kind, itemId)
  }
  async searchChunks(q: { vector: number[]; text: string; limit: number }): Promise<Hit[]> {
    const live = await this.tryWorker<Hit[]>('/chunks/search', { method: 'POST', body: { vector: Array.from(q.vector), text: q.text, limit: q.limit } })
    return live ?? this.shelf().search(q)
  }
  async chunkCount() {
    const live = await this.tryWorker<{ count: number }>('/chunks/count')
    return live ? live.count : this.shelf().count()
  }

  /** The Worker knows its own people, so it says who this is. */
  async viewer(): Promise<Viewer | null> {
    const s = await this.api.call<{ user: { id: string; role: string } | null }>('/session').catch(() => null)
    if (!s?.user) return null
    return { id: s.user.id, admin: s.user.role === 'admin' || s.user.role === 'owner' }
  }
  async projects(): Promise<Project[]> {
    let live = await this.tryWorker<{ projects: Project[]; canManage?: boolean }>('/projects')
    if (live && !live.projects.length && live.canManage && (await this.carryProjectsOver())) {
      live = (await this.tryWorker<{ projects: Project[] }>('/projects')) ?? live
    }
    if (live) return live.projects.map((p) => ({ ...p, members: p.members ?? [] }))
    return ((await this.raw()).projects ?? []).map((p: any) => ({ ...p, members: p.members ?? [] }))
  }
  /**
   * A Worker that has just learnt about projects starts with none, while this
   * workspace may have been keeping its own in its settings all along (that is
   * what an older Worker made it do). Left there they would simply vanish from
   * the app the day the Worker is brought up to date. So the first time an
   * admin's app finds the Worker's list empty and the settings' list not, the
   * projects, who is in them and what is in them are handed over, once: the
   * note left behind stops projects that are later deleted from coming back.
   */
  private async carryProjectsOver(): Promise<boolean> {
    const cur = await this.raw()
    const mine: Project[] = cur.projects ?? []
    if (!mine.length || cur.projectsCarriedAt) return false
    await this.api.call('/projects', { method: 'PUT', body: { projects: mine } })
    const byPlace = new Map<string, string[]>()
    for (const [key, project] of Object.entries((cur.projectItems ?? {}) as Record<string, string>)) {
      const [kind, ...id] = key.split(':')
      const at = `${kind}|${project}`
      byPlace.set(at, [...(byPlace.get(at) ?? []), id.join(':')])
    }
    for (const [at, ids] of byPlace) {
      const [kind, project] = at.split('|')
      await this.api.call('/projects/assign', { method: 'POST', body: { kind, ids, project } }).catch(() => {})
    }
    await this.writeRaw({ ...cur, projectsCarriedAt: new Date().toISOString() })
    return true
  }
  async saveProjects(list: Project[]) {
    const live = await this.tryWorker('/projects', { method: 'PUT', body: { projects: list } })
    if (live) return
    const cur = await this.raw()
    await this.writeRaw({ ...cur, projects: list })
  }
  async invites(): Promise<Invite[]> {
    const live = await this.tryWorker<any[]>('/invites')
    if (live)
      return live.map((i) => ({
        id: i.id,
        email: i.email,
        role: i.role,
        projects: i.projects ?? [],
        createdAt: i.created_at ?? '',
        expiresAt: new Date(i.expires_at ?? Date.now()).toISOString(),
        usedAt: i.used_at ?? null,
      }))
    return ((await this.raw()).invites ?? []).map((i: any) => ({ ...i, projects: i.projects ?? [] }))
  }
  async createInvite(i: { email: string; role: 'admin' | 'member'; projects: { id: string; role: ProjectRole }[] }) {
    /* Two kinds of Worker answer to POST /invites, and they mean different
       things by it. Alfredo's own keeps invitations (it can list them) and
       hands back one of its own. An older one, a team's own, only knows "let
       this address in as an editor": asked for an invitation it let the
       address in there and then, dropped the projects chosen for them, and
       answered in a shape that crashed the page. Whether it can LIST
       invitations is what tells them apart, and asking that changes nothing.
       For the older kind the invitation is Alfredo's, kept in the workspace's
       settings with its projects, and the Worker is told about the person when
       they accept (see acceptInvite). */
    const keepsInvites = await this.tryWorker<unknown[]>('/invites')
    const live = keepsInvites ? await this.tryWorker<Record<string, any>>('/invites', { method: 'POST', body: i }) : null
    if (live) {
      /* Workers of different ages answer this differently: the invite under
         `invite` with the token beside it, or the invite's own fields with the
         token among them. Taking the first shape for granted is what made an
         invitation die with "Cannot read properties of undefined". */
      const made: Record<string, any> = live.invite && typeof live.invite === 'object' ? live.invite : live
      const token: unknown = live.token ?? made.token
      if (typeof token !== 'string' || !token) {
        throw new Error(`This workspace's Worker accepted the invitation but handed back no link for it (it answered with: ${Object.keys(live).join(', ') || 'nothing'}). It may be older than invite links are.`)
      }
      return {
        token,
        invite: {
          id: String(made.id ?? ''),
          email: made.email ?? i.email,
          role: made.role === 'admin' ? 'admin' : i.role,
          projects: Array.isArray(made.projects) ? made.projects : i.projects,
          createdAt: made.created_at ?? new Date().toISOString(),
          expiresAt: new Date(made.expires_at ?? Date.now() + 14 * 86400000).toISOString(),
          usedAt: made.used_at ?? null,
        } as Invite,
      }
    }
    const token = inviteToken()
    const invite: Invite = {
      id: randomUUID(),
      email: i.email,
      role: i.role,
      projects: i.projects,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 14 * 86400000).toISOString(),
      usedAt: null,
    }
    const cur = await this.raw()
    await this.writeRaw({ ...cur, invites: [...(cur.invites ?? []), { ...invite, tokenHash: (await hashToken(token)) }] })
    return { invite, token }
  }
  async revokeInvite(id: string) {
    const live = (await this.tryWorker<unknown[]>('/invites')) ? await this.tryWorker(`/invites/${id}`, { method: 'DELETE' }) : null
    if (live) return
    const cur = await this.raw()
    await this.writeRaw({ ...cur, invites: (cur.invites ?? []).filter((i: any) => i.id !== id) })
  }
  async inviteFor(token: string) {
    const hash = await hashToken(token)
    const hit = (await this.raw()).invites?.find((i: any) => i.tokenHash === hash)
    if (!hit || hit.usedAt || Date.parse(hit.expiresAt) < Date.now()) return null
    const { tokenHash: _drop, ...invite } = hit
    return invite as Invite
  }
  async acceptInvite(token: string, person: { name: string; email: string; userId?: string | null }) {
    const invite = await this.inviteFor(token)
    if (!invite) throw new Error('This invitation is no longer good. Ask for a new one.')
    if (invite.email.toLowerCase() !== person.email.toLowerCase()) throw new Error('This invitation was sent to a different email.')
    // The Worker keeps the people; the memberships live beside the projects.
    await this.api.call('/invites', { method: 'POST', body: { email: person.email, role: invite.role === 'admin' ? 'owner' : 'editor' } }).catch(() => {})
    const who = (await this.members()).find((m) => m.email?.toLowerCase() === person.email.toLowerCase())
    const cur = await this.raw()
    const projects = (cur.projects ?? []).map((p: any) => {
      const want = invite.projects.find((x) => x.id === p.id)
      if (!want || !who) return p
      const members = [...(p.members ?? []).filter((m: ProjectMember) => m.personId !== who.id), { personId: who.id, role: want.role }]
      return { ...p, members }
    })
    const invites = (cur.invites ?? []).map((i: any) => (i.id === invite.id ? { ...i, usedAt: new Date().toISOString() } : i))
    await this.writeRaw({ ...cur, projects, invites })
    return who ?? { id: person.email, name: person.name, email: person.email, avatar: null, role: invite.role }
  }
  async projectMap() {
    const live = await this.tryWorker<Record<string, string>>('/project-items')
    if (live) return live
    return ((await this.raw()).projectItems ?? {}) as Record<string, string>
  }
  async assign(kind: ItemKind, ids: string[], project: string | null) {
    if (!ids.length) return
    const live = await this.tryWorker('/projects/assign', { method: 'POST', body: { kind, ids, project } })
    if (live) return
    const cur = await this.raw()
    const map = { ...(cur.projectItems ?? {}) }
    for (const id of ids) {
      if (project) map[`${kind}:${id}`] = project
      else delete map[`${kind}:${id}`]
    }
    await this.writeRaw({ ...cur, projectItems: map })
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

// --- routes -------------------------------------------------------------------

export function v2Routes(current: () => { workspace: Workspace; db: unknown } | undefined) {
  const app = new Hono()

  const store = () => storeFor(current())

  app.onError((e, c) => {
    const status = (e as any).status ?? (e instanceof Conflict ? 409 : 500)
    return c.json({ error: e.message }, status)
  })

  /* The workspace keeps itself read in: using it is what wakes the look for
     anything new, a few seconds later and at most every few minutes. */
  app.use('*', async (c, next) => {
    await next()
    try {
      const cur = current()
      if (cur && c.req.method === 'GET') theMachine().keepReadIn(storeFor(cur), cur.workspace.id)
    } catch {}
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
    const { me } = await mine(c)
    if (!me.admin) return c.json({ error: 'Only an admin can add people.' }, 403)
    const b = await c.req.json<{ email: string; role?: string }>()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email ?? '')) return c.json({ error: 'Enter a valid email.' }, 400)
    return c.json(await store().invite(b.email.trim().toLowerCase(), b.role === 'admin' ? 'admin' : 'member'))
  })
  app.patch('/members/:id', async (c) => {
    const b = await c.req.json<{ role?: string; avatar?: string }>()
    const { me } = await mine(c)
    // Anyone may set their own photo; only an admin hands out roles, and an
    // admin may pass that on (Alfredo never stops the last one stepping down).
    if (b.role && !me.admin) return c.json({ error: 'Only an admin can change what someone may do.' }, 403)
    if (b.avatar && !me.admin && me.id !== c.req.param('id')) return c.json({ error: "You can only change your own photo." }, 403)
    whoCache.clear()
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

  // --- projects -------------------------------------------------------------
  /**
   * The project a request is scoped to (x-project header): a project id,
   * NONE for the work that is in no project, or null for all of it.
   */
  const projectOf = (c: any): string | null => {
    const p = c.req.header('x-project') ?? c.req.query('project') ?? ''
    return p && p !== 'all' ? p : null
  }
  /** The mapping, or none when this database has no projects table yet. */
  const mapOf = (st: Store) => st.projectMap().catch(() => ({}) as Record<string, string>)
  /** Keep what belongs to the project (all when unscoped) and say which project each item is in. */
  async function scoped<T extends { id: string }>(c: any, kind: ItemKind, list: T[]): Promise<(T & { project: string | null })[]> {
    const p = projectOf(c)
    const [map, { me, allowed }, set] = await Promise.all([mapOf(store()), mine(c), store().settings()])
    const ok = new Set(allowed.map((x) => x.id))
    // Without projects a workspace is one room. With them, you see yours, and
    // work that is in none waits for an admin to file it.
    const unfiledIsMine = !set.projects?.enabled || me.admin
    return list
      .filter((x) => {
        const inP = map[`${kind}:${x.id}`]
        if (p === NO_PROJECT) return !inP
        if (p) return inP === p
        return inP ? ok.has(inP) : unfiledIsMine
      })
      .map((x) => ({ ...x, project: map[`${kind}:${x.id}`] ?? null }))
  }
  async function one<T extends { id: string }>(kind: ItemKind, item: T): Promise<T & { project: string | null }> {
    const map = await mapOf(store())
    return { ...item, project: map[`${kind}:${item.id}`] ?? null }
  }
  /** Something just made lands in the project the request is scoped to. */
  async function placed<T extends { id: string }>(c: any, kind: ItemKind, item: T): Promise<T & { project: string | null }> {
    const p = projectOf(c)
    if (!p || p === NO_PROJECT) return { ...item, project: null }
    await store().assign(kind, [item.id], p)
    return { ...item, project: p }
  }
  /**
   * Refuses a write this person may not make: into a read-only project, or on
   * an item that lives in one. Items in no project follow the workspace.
   */
  async function guardWrite(c: any, kind: ItemKind, id?: string) {
    const st = store()
    const { me, all } = await mine(c)
    const scoped = projectOf(c)
    const check = async (pid: string | null | undefined) => {
      if (!pid || pid === NO_PROJECT) return null
      const p = all.find((x) => x.id === pid)
      if (!p) return c.json({ error: 'No such project.' }, 404)
      if (!canWriteProject(p, me)) return c.json({ error: `You have read-only access to ${p.name}.` }, 403)
      return null
    }
    const onScope = await check(scoped)
    if (onScope) return onScope
    if (!id) return null
    const map = await mapOf(st)
    return check(map[`${kind}:${id}`])
  }

  /** Refuses a request scoped to a project this person cannot open. */
  async function guard(c: any) {
    const p = projectOf(c)
    if (!p || p === NO_PROJECT) return null
    const { all, allowed } = await mine(c)
    if (allowed.some((x) => x.id === p)) return null
    // A project that is gone is not a refusal: the app should forget it.
    if (!all.some((x) => x.id === p)) return c.json({ error: 'That project no longer exists.', gone: true }, 404)
    return c.json({ error: 'You do not have access to that project.' }, 403)
  }
  /** Which cards count for a project (or for the work in no project). */
  async function cardFilter(st: Store, p: string) {
    const map = await mapOf(st)
    if (p === NO_PROJECT) return (id: string) => !map[`card:${id}`]
    return (id: string) => map[`card:${id}`] === p
  }

  // Who someone is, per workspace, for a few seconds: every list asks, and it
  // is two round trips to a database that does not change that fast.
  const whoCache = new Map<string, { at: number; value: Viewer }>()

  /** Who is asking, as a row in this workspace's people, and whether they run it. */
  async function who(c: any): Promise<Viewer> {
    const person0 = c.get?.('person') as { email?: string } | undefined
    const key = `${current()?.workspace.id ?? ''}|${person0?.email ?? ''}`
    const hit = whoCache.get(key)
    if (hit && Date.now() - hit.at < 15_000) return hit.value
    const value = await whoUncached(c)
    whoCache.set(key, { at: Date.now(), value })
    return value
  }
  async function whoUncached(c: any): Promise<Viewer> {
    // Where the database keeps its own people, its answer is the one that counts.
    const asked = await store().viewer?.()
    if (asked) return asked
    const person = c.get?.('person') as { id: string; email: string } | undefined
    const people = await store().members()
    // No sign-in at all means a workspace on this Mac: whoever is at the
    // keyboard owns it, and there is nobody to keep anything from.
    if (!person?.email) return { id: people[0]?.id ?? null, admin: true }
    // A workspace nobody has been made admin of yet is run by whoever is in
    // it: someone has to be able to hand out the first roles.
    const settled = people.some((p) => p.role === 'admin')
    const mine = people.find((p) => p.email?.toLowerCase() === person.email.toLowerCase())
    return { id: mine?.id ?? null, admin: !settled || mine?.role === 'admin' }
  }
  /** The projects this person may open, and what they may do in each. */
  async function mine(c: any) {
    const [list, me] = await Promise.all([store().projects(), who(c)])
    const allowed = list.filter((p) => canOpenProject(p, me))
    return { me, all: list, allowed, roleOf: (id: string) => projectRole(list.find((p) => p.id === id) ?? ({ members: [] } as any), me) }
  }
  /** What a project looks like to the person asking: their role, and the people in it when they run it. */
  const seenBy = (p: Project, me: Viewer) => ({
    id: p.id,
    name: p.name,
    color: p.color,
    ...(p.archived ? { archived: true } : {}),
    role: projectRole(p, me),
    members: me.admin ? p.members : undefined,
  })

  const learn = (kind: ItemKind, id: string) => theMachine().touch(store(), kind, id, current()?.workspace.id ?? '')

  app.get('/projects', async (c) => {
    const st = store()
    const [set, { me, allowed }] = await Promise.all([st.settings(), mine(c)])
    return c.json({
      enabled: !!set.projects?.enabled,
      projects: allowed.map((p) => seenBy(p, me)),
      canManage: me.admin,
      me: me.id,
    })
  })
  app.put('/projects', async (c) => {
    const st = store()
    const { me } = await mine(c)
    if (!me.admin) return c.json({ error: 'Only an admin can change the projects here.' }, 403)
    const b = await c.req.json<{ enabled?: boolean; projects?: Partial<Project>[] }>()
    if (b.projects) {
      const before = await st.projects()
      const next: Project[] = []
      for (const x of b.projects) {
        const name = (x.name ?? '').trim().slice(0, 60)
        if (!name) return c.json({ error: 'Every project needs a name.' }, 400)
        const members = (x.members ?? [])
          .filter((m: any) => m && typeof m.personId === 'string')
          .map((m: any) => ({ personId: m.personId as string, role: (PROJECT_ROLES.includes(m.role) ? m.role : 'write') as ProjectRole }))
        next.push({ id: x.id || randomUUID(), name, color: PROJECT_COLORS.includes(x.color ?? '') ? x.color! : 'slate', members, ...(x.archived ? { archived: true } : {}) })
      }
      // A deleted project lets go of its items; they stay, in no project.
      const gone = new Set(before.filter((p) => !next.some((n) => n.id === p.id)).map((p) => p.id))
      if (gone.size) {
        const map = await mapOf(st)
        for (const kind of ITEM_KINDS) {
          const ids = Object.entries(map).filter(([k, v]) => k.startsWith(kind + ':') && gone.has(v)).map(([k]) => k.slice(kind.length + 1))
          await st.assign(kind, ids, null)
        }
      }
      await st.saveProjects(next)
    }
    if (b.enabled !== undefined) await st.saveSettings({ projects: { enabled: !!b.enabled } })
    whoCache.clear()
    const [set, after] = await Promise.all([st.settings(), mine(c)])
    return c.json({ enabled: !!set.projects?.enabled, projects: after.allowed.map((p) => seenBy(p, after.me)), canManage: after.me.admin, me: after.me.id })
  })
  /* Joining: an admin makes a link, the person opens Alfredo and pastes it. */
  app.get('/invites', async (c) => {
    const { me } = await mine(c)
    if (!me.admin) return c.json({ error: 'Only an admin can see the invitations.' }, 403)
    return c.json(await store().invites())
  })
  app.post('/invites', async (c) => {
    const st = store()
    const { me, all } = await mine(c)
    if (!me.admin) return c.json({ error: 'Only an admin can invite people.' }, 403)
    const b = await c.req.json<{ email?: string; role?: string; projects?: { id: string; role: ProjectRole }[] }>()
    const email = (b.email ?? '').trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return c.json({ error: 'Enter a valid email.' }, 400)
    const projects = (b.projects ?? [])
      .filter((p) => all.some((x) => x.id === p.id))
      .map((p) => ({ id: p.id, role: (PROJECT_ROLES.includes(p.role) ? p.role : 'write') as ProjectRole }))
    const { invite, token } = await st.createInvite({ email, role: b.role === 'admin' ? 'admin' : 'member', projects })
    // The link carries where the workspace is and nothing secret: a Supabase
    // project with its publishable key, or the Worker a teammate signs in to.
    const cur = current()?.workspace
    const name = (await st.settings()).name ?? cur?.name ?? 'Workspace'
    const k = cur?.kind === 'remote' ? theMachine().inviteKeys(cur.id) : null
    const link = k
      ? inviteLink({ kind: 'supabase', url: k.url, anonKey: k.anonKey, name, token })
      : cur?.kind === 'cloudflare' && cur.cloudflare?.url
        ? inviteLink({ kind: 'cloudflare', url: cur.cloudflare.url, name, token })
        : null
    return c.json({ invite, token, link })
  })
  /* Where this workspace is, for someone who already has an account in it: the
     same link an invitation travels in, without the invitation. They add it
     and sign in as they already can. Only a database that signs people in
     itself can be joined this way. */
  app.get('/workspace-link', async (c) => {
    const { me } = await mine(c)
    if (!me.admin) return c.json({ error: 'Only an admin can share the workspace link.' }, 403)
    const cur = current()?.workspace
    const k = cur?.kind === 'remote' ? theMachine().inviteKeys(cur.id) : null
    if (!k) return c.json({ error: 'This workspace signs people in with an invitation; make one instead.' }, 400)
    const name = (await store().settings()).name ?? cur?.name ?? 'Workspace'
    return c.json({ link: inviteLink({ kind: 'supabase', url: k.url, anonKey: k.anonKey, name }) })
  })
  app.delete('/invites/:id', async (c) => {
    const { me } = await mine(c)
    if (!me.admin) return c.json({ error: 'Only an admin can revoke an invitation.' }, 403)
    await store().revokeInvite(c.req.param('id'))
    return c.json({ ok: true })
  })
  /* Spending an invitation from the hosted site, where there is no app to do
     it: whoever is signed in becomes the person the invitation names. The
     desktop app does the same through the database's own function. */
  app.post('/invites/claim', async (c) => {
    const person = (c as any).get?.('person') as { id?: string; email?: string; name?: string } | undefined
    if (!person?.email) return c.json({ error: 'Sign in first.' }, 401)
    const b = await c.req.json<{ token?: string; name?: string }>()
    if (!b.token) return c.json({ error: 'No invitation to accept.' }, 400)
    try {
      const me = await store().acceptInvite(b.token, { name: b.name?.trim() || person.name || person.email.split('@')[0], email: person.email, userId: person.id ?? null })
      whoCache.clear()
      return c.json(me)
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  })

  app.post('/projects/assign', async (c) => {
    const b = await c.req.json<{ kind: ItemKind; ids: string[]; project: string | null }>()
    if (!ITEM_KINDS.includes(b.kind) || !Array.isArray(b.ids)) return c.json({ error: 'Say what to move: kind and ids.' }, 400)
    const st = store()
    const { me, all } = await mine(c)
    const target = b.project ? all.find((p) => p.id === b.project) : null
    if (b.project && !target) return c.json({ error: 'No such project.' }, 404)
    if (target && !canWriteProject(target, me)) return c.json({ error: `You have read-only access to ${target.name}.` }, 403)
    // Taking something out of a project is a change to that project too.
    const map = await mapOf(st)
    for (const id of b.ids) {
      const from = map[`${b.kind}:${id}`]
      const fromP = from ? all.find((p) => p.id === from) : null
      if (fromP && !canWriteProject(fromP, me)) return c.json({ error: `You have read-only access to ${fromP.name}.` }, 403)
    }
    await st.assign(b.kind, b.ids, b.project ?? null)
    return c.json({ ok: true })
  })

  async function cycles(project: string | null = null): Promise<CyclesView> {
    const st = store()
    const [settings, all] = await Promise.all([st.settings(), st.tally()])
    const t = all
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
          return cycles(project)
        }
      }
    }

    // Rollover is for the whole workspace; the counts shown are the project's.
    const counts = project ? await st.tally(await cardFilter(st, project)) : t
    const starts = new Set<string>()
    for (const [w, n] of counts.weeks) if (n.total) starts.add(m.startOf(w))
    starts.add(current)
    for (let i = 1, s = current; i <= cfg.upcoming; i++) starts.add((s = m.next(s)))
    const list = [...starts].sort().map((start) => {
      const tally = m.weeksOf(start).reduce((a, w) => ({ total: a.total + (counts.weeks.get(w)?.total ?? 0), done: a.done + (counts.weeks.get(w)?.done ?? 0) }), { total: 0, done: 0 })
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
    return { current, cycles: list, backlog: counts.backlog, settings: cfg, next: m.next(current) }
  }

  app.get('/weeks', async (c) => (await guard(c)) ?? c.json(await cycles(projectOf(c))))
  /**
   * Finish a cycle: its unfinished cards go somewhere else. `next` is the
   * cycle after it, `current` the one running now (what carrying over from a
   * cycle that ended weeks ago is usually meant to do), `backlog` no cycle.
   */
  app.post('/weeks/complete', async (c) => {
    const b = await c.req.json<{ start: string; to: 'next' | 'current' | 'backlog' }>()
    const start = weekParam(b.start)
    if (!start || start === 'backlog') return c.json({ error: 'Pick a cycle.' }, 400)
    const denied = await guardWrite(c, 'card')
    if (denied) return denied
    const st = store()
    const view = await cycles()
    const m = cycleMath((await st.tally()).anchor ?? start, view.settings.length)
    const open = (await scoped(c, 'card', await st.cardsIn(m.weeksOf(start)))).filter((x) => x.status !== 'done').map((x) => x.id)
    const to = b.to === 'backlog' ? null : b.to === 'current' && view.current !== start ? view.current : m.next(start)
    await st.moveCards(open, to)
    return c.json({ moved: open.length, to })
  })
  app.get('/cards', async (c) => {
    const denied = await guard(c)
    if (denied) return denied
    const w = weekParam(c.req.query('week'))
    if (w === 'backlog') return c.json(await scoped(c, 'card', await store().cardsIn('backlog')))
    const view = await cycles()
    const st = store()
    const start = w ?? view.current
    const m = cycleMath((await st.tally()).anchor ?? start, view.settings.length)
    return c.json(await scoped(c, 'card', await st.cardsIn(m.weeksOf(m.startOf(start)))))
  })
  app.post('/cards', async (c) => {
    const denied = await guardWrite(c, 'card')
    if (denied) return denied
    const b = await c.req.json<{ title: string; status?: Status; week?: string }>()
    if (!b.title?.trim()) return c.json({ error: 'Give the card a title.' }, 400)
    const made = await placed(c, 'card', await store().createCard({ title: b.title.trim(), status: STATUSES.includes(b.status!) ? b.status : 'todo', week: weekParam(b.week) }))
    learn('card', made.id)
    return c.json(made)
  })
  app.patch('/cards/:id', async (c) => {
    const denied = await guardWrite(c, 'card', c.req.param('id'))
    if (denied) return denied
    const b = await c.req.json<Record<string, any>>()
    if (b.week !== undefined) b.week = weekParam(b.week) ?? 'backlog'
    const card = await one('card', await store().updateCard(c.req.param('id'), b))
    learn('card', card.id)
    return c.json(card)
  })
  app.delete('/cards/:id', async (c) => {
    const denied = await guardWrite(c, 'card', c.req.param('id'))
    if (denied) return denied
    await store().deleteCard(c.req.param('id'))
    await theMachine().forget(store(), 'card', c.req.param('id'))
    return c.json({ ok: true })
  })

  app.get('/docs', async (c) => (await guard(c)) ?? c.json(await scoped(c, 'doc', await store().docs())))
  app.get('/docs/:id', async (c) => c.json(await one('doc', await store().doc(c.req.param('id')))))
  app.post('/docs', async (c) => {
    const denied = await guardWrite(c, 'doc')
    if (denied) return denied
    const b = await c.req.json<{ title?: string; body?: string }>()
    const doc = await placed(c, 'doc', await store().createDoc(b.title?.trim() || 'Untitled', b.body ?? ''))
    learn('doc', doc.id)
    return c.json(doc)
  })
  app.put('/docs/:id', async (c) => {
    const denied = await guardWrite(c, 'doc', c.req.param('id'))
    if (denied) return denied
    const saved = await store().saveDoc(c.req.param('id'), await c.req.json())
    learn('doc', saved.id)
    return c.json(saved)
  })

  app.get('/canvases', async (c) => (await guard(c)) ?? c.json(await scoped(c, 'canvas', await store().canvases())))
  app.get('/canvases/:id', async (c) => c.json(await one('canvas', await store().canvas(c.req.param('id')))))
  app.post('/canvases', async (c) => {
    const denied = await guardWrite(c, 'canvas')
    if (denied) return denied
    const b = await c.req.json<{ title?: string }>()
    const canvas = await placed(c, 'canvas', await store().createCanvas(b.title?.trim() || 'Untitled canvas'))
    learn('canvas', canvas.id)
    return c.json(canvas)
  })
  app.put('/canvases/:id', async (c) => {
    const denied = await guardWrite(c, 'canvas', c.req.param('id'))
    if (denied) return denied
    const saved = await store().saveCanvas(c.req.param('id'), await c.req.json())
    learn('canvas', saved.id)
    return c.json(saved)
  })

  app.get('/meetings', async (c) => (await guard(c)) ?? c.json(await scoped(c, 'meeting', await store().meetings())))
  app.get('/meetings/:id', async (c) => c.json(await one('meeting', await store().meeting(c.req.param('id')))))
  app.post('/meetings', async (c) => {
    const denied = await guardWrite(c, 'meeting')
    if (denied) return denied
    const b = await c.req.json<{ title?: string; transcript?: string; notes?: string; startedAt?: string; durationS?: number }>()
    const meeting = await placed(c, 'meeting', await store().createMeeting({ ...b, title: b.title?.trim() || 'Meeting' }))
    learn('meeting', meeting.id)
    return c.json(meeting)
  })
  app.put('/meetings/:id', async (c) => {
    const denied = await guardWrite(c, 'meeting', c.req.param('id'))
    if (denied) return denied
    const saved = await store().saveMeeting(c.req.param('id'), await c.req.json())
    learn('meeting', saved.id)
    return c.json(saved)
  })

  for (const kind of ['docs', 'canvases', 'meetings'] as const) {
    app.delete(`/${kind}/:id`, async (c) => {
      // `one` is taken by the helper above; this is the singular of the tab.
      const single: ItemKind = kind === 'docs' ? 'doc' : kind === 'canvases' ? 'canvas' : 'meeting'
      const denied = await guardWrite(c, single, c.req.param('id'))
      if (denied) return denied
      await store().remove(kind, c.req.param('id'))
      await theMachine().forget(store(), single, c.req.param('id'))
      return c.json({ ok: true })
    })
  }

  /* What needs this machine (the microphone, the local models, files on its
     disk, a CLI on its PATH) is added by whoever has one: the desktop app does,
     the hosted site does not. See v2-desktop.ts. */
  theMachine().routes(app, { store, current, mine, projectOf, mapOf, NO_PROJECT })

  return app
}
