// The v2 API: the same calls whatever database the workspace lives in, and
// whichever project is open (every call carries it; see project.svelte.ts).
import { api, post } from '../lib/session.svelte'
import { projectHeader, forgetProject } from './project.svelte'
import { counted } from './net.svelte'

export type Status = 'todo' | 'progress' | 'review' | 'done'
export const STATUSES: { id: Status; label: string }[] = [
  { id: 'todo', label: 'Todo' },
  { id: 'progress', label: 'In progress' },
  { id: 'review', label: 'Review' },
  { id: 'done', label: 'Done' },
]
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
  week: string | null
  /** Which project it is in, when the workspace uses projects. */
  project?: string | null
}
export type Cycles = { length: 1 | 2 | 4; rollover: 'ask' | 'next' | 'backlog'; upcoming: number; since?: string }
export type CycleInfo = { start: string; end: string; label: string; total: number; done: number; current: boolean; past: boolean }
export type CyclesView = { current: string; cycles: CycleInfo[]; backlog: number; settings: Cycles; next: string }
export type DocSummary = { id: string; title: string; folder: string | null; updatedAt: string; excerpt: string } & InProject
export type Doc = DocSummary & { body: string; revision: number }
export type CanvasSummary = { id: string; title: string; updatedAt: string; nodeCount: number; thumb: string | null } & InProject
export type Canvas = { id: string; title: string; revision: number; nodes: any[]; edges: any[] } & InProject
export type MeetingSummary = { id: string; title: string; startedAt: string; durationS: number | null; hasTranscript: boolean; status: string } & InProject
export type Meeting = MeetingSummary & { notes: string; transcript: string | null; revision: number }
/** board, docs, canvas, meetings, or a pack's type (see packs/). */
export type TabType = string
export type TabDef = { id: string; type: TabType; name: string; hidden?: boolean; columns?: string[] }
export type Settings = { name?: string; logo?: string | null; tabs: TabDef[]; cycles?: Cycles; projects?: { enabled: boolean } }
/** Which project an item is in, when the workspace uses them. */
export type InProject = { project?: string | null }

const P = '/api/v2'

/**
 * A project can go away while the app still has it open (someone removed it,
 * or your access to it). The workspace should not jam on that: forget it,
 * open another, and run the call again.
 */
async function withProject<T>(run: () => Promise<T>): Promise<T> {
  // What this call told the server, so a refusal about a project can be told
  // apart from a refusal about anything else.
  const sent = projectHeader()['x-project']
  try {
    return await run()
  } catch (e) {
    const status = (e as Error).message.match(/\((\d{3})\)/)?.[1]
    if (!sent || (status !== '404' && status !== '403')) throw e
    await forgetProject()
    return run()
  }
}

export const v2 = {
  get: <T>(path: string) => counted(() => withProject(() => api<T>(P + path, projectHeader()))),
  post: <T>(path: string, body: unknown = {}) => counted(() => withProject(() => post<T>(P + path, body, 'POST', projectHeader()))),
  put: <T>(path: string, body: unknown) => counted(() => withProject(() => post<T>(P + path, body, 'PUT', projectHeader()))),
  patch: <T>(path: string, body: unknown) => counted(() => withProject(() => post<T>(P + path, body, 'PATCH', projectHeader()))),
  del: <T>(path: string) => counted(() => withProject(() => post<T>(P + path, {}, 'DELETE', projectHeader()))),
}

/** "4m ago", "Yesterday", "Sep 12". */
export function ago(iso: string | null | undefined) {
  if (!iso) return ''
  const d = new Date(iso)
  const s = (Date.now() - d.getTime()) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  if (s < 172800) return 'Yesterday'
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase()

/** ISO week number of a Monday, for boards whose weeks are not numbered. */
export function isoWeek(monday: string) {
  const d = new Date(`${monday}T00:00:00`)
  d.setDate(d.getDate() + 3)
  const jan4 = new Date(d.getFullYear(), 0, 4)
  return 1 + Math.round(((d.getTime() - jan4.getTime()) / 86400000 - 3 + ((jan4.getDay() + 6) % 7)) / 7)
}

/** "Sep 15 – 21", or across months "Sep 29 – Oct 5". */
export function weekRange(start: string, end: string) {
  const a = new Date(`${start}T00:00:00`)
  const b = new Date(`${end}T00:00:00`)
  const m = (d: Date) => d.toLocaleDateString(undefined, { month: 'short' })
  return a.getMonth() === b.getMonth() ? `${m(a)} ${a.getDate()} – ${b.getDate()}` : `${m(a)} ${a.getDate()} – ${m(b)} ${b.getDate()}`
}

/** Stable, calm colour per person for initials avatars. */
const TONES = ['#B4C3D3', '#B7C7AE', '#DDB6A1', '#C7BDD6', '#E3D3B0', '#D6D1C8']
export const toneFor = (s: string) => TONES[[...s].reduce((a, c) => a + c.charCodeAt(0), 0) % TONES.length]

/** Read an image file as a data URL, downscaled so it stays small. */
export async function imageDataUrl(file: File, max = 256): Promise<string> {
  const bmp = await createImageBitmap(file)
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height))
  const c = document.createElement('canvas')
  c.width = Math.round(bmp.width * scale)
  c.height = Math.round(bmp.height * scale)
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height)
  return c.toDataURL('image/png')
}
