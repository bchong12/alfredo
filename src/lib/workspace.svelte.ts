// Which workspace the UI is looking at.
//
// A workspace is a folder on this machine (personal) or the shared Supabase
// project. Every request to the REST API names one in the x-workspace
// header, and the server answers from that workspace's database. Switching is
// therefore nothing more than changing one string and reloading the views.

import { prefixFor, setRefPrefix } from './ref'

/** Same base the session module uses; duplicated to avoid an import cycle. */
const apiUrl = (path: string) => `${import.meta.env.VITE_API_BASE ?? ''}${path}`

export type Workspace = {
  id: string
  name: string
  kind: 'local' | 'remote' | 'cloudflare'
  cloudflare?: { url: string } | null
  /** A membership holds only the publishable key: the database decides what it shows. */
  supabase?: { url: string; mode?: 'owner' | 'member' } | null
  repos: string[]
  prefix?: string
  canvas?: { baseUrl: string; connected: boolean } | null
  composio?: Record<string, string | string[]>
  automations?: unknown[]
  createdAt: string
}

const KEY = 'alfred.workspace'
/** An invitation waiting to be spent, once the person signs in. */
const INVITE = (ws: string) => `alfredo.invite.${ws}`

export function rememberInvite(ws: string, token: string) {
  try {
    localStorage.setItem(INVITE(ws), token)
  } catch {}
}
export function pendingInvite(ws: string) {
  try {
    return localStorage.getItem(INVITE(ws))
  } catch {
    return null
  }
}
export function clearInvite(ws: string) {
  try {
    localStorage.removeItem(INVITE(ws))
  } catch {}
}

export const workspace = $state({
  list: [] as Workspace[],
  activeId: '' as string,
  ready: false,
  /** The deployed site: one shared workspace, no registry, nothing local. */
  hosted: false,
})

export const activeWorkspace = () => workspace.list.find((w) => w.id === workspace.activeId) ?? null
export const isLocal = () => activeWorkspace()?.kind === 'local'
export const hasRemote = () => workspace.list.some((w) => w.kind === 'remote')

function remembered() {
  try {
    return localStorage.getItem(KEY) ?? ''
  } catch {
    return ''
  }
}

function syncPrefix() {
  const w = activeWorkspace()
  if (w) setRefPrefix(w.prefix ?? prefixFor(w.name))
}

export function pick(id: string) {
  if (!workspace.list.some((w) => w.id === id)) return
  workspace.activeId = id
  syncPrefix()
  try {
    localStorage.setItem(KEY, id)
  } catch {}
}

/** Load the registry. The remembered choice wins, then the server's active one. */
export async function loadWorkspaces() {
  const r = await fetch(apiUrl('/api/workspaces')).catch(() => null)
  if (!r || !r.ok) {
    // No registry behind this API: it is the public site, which serves the
    // shared workspace and nothing else.
    workspace.hosted = true
    const cfg = await fetch(apiUrl('/config')).then((x) => x.json()).catch(() => ({}))
    const name = cfg.brand ?? 'Alfredo'
    workspace.list = [{ id: 'hosted', name, kind: 'remote', repos: [], prefix: cfg.prefix, createdAt: '' }]
    workspace.activeId = 'hosted'
    // The tab says whose CRM this is, not the app's own name.
    if (typeof document !== 'undefined') document.title = `${name} CRM`
    syncPrefix()
    workspace.ready = true
    return
  }
  const data = (await r.json()) as { active: string | null; workspaces: Workspace[] }
  workspace.list = data.workspaces
  const want = remembered() || data.active || data.workspaces[0]?.id || ''
  workspace.activeId = data.workspaces.some((w) => w.id === want) ? want : (data.workspaces[0]?.id ?? '')
  syncPrefix()
  workspace.ready = true
}

async function send<T>(path: string, init: RequestInit): Promise<T> {
  const r = await fetch(apiUrl(path), { ...init, headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) } })
  if (!r.ok) {
    const detail = await r.json().catch(() => null)
    throw new Error(detail?.error ?? `${path} failed (${r.status})`)
  }
  return r.json() as Promise<T>
}

export async function createWorkspace(name: string, repos: string[] = []) {
  const w = await send<Workspace>('/api/workspaces', { method: 'POST', body: JSON.stringify({ name, repos }) })
  workspace.list = [...workspace.list, w]
  pick(w.id)
  return w
}

export async function updateWorkspace(
  id: string,
  patch: { name?: string; repos?: string[]; prefix?: string; canvas?: { baseUrl: string; token: string } | null; composio?: Record<string, string | string[]>; automations?: unknown[] },
) {
  const w = await send<Workspace>(`/api/workspaces/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
  workspace.list = workspace.list.map((x) => (x.id === id ? w : x))
  syncPrefix()
  return w
}

export async function removeWorkspace(id: string) {
  await send(`/api/workspaces/${id}`, { method: 'DELETE' })
  workspace.list = workspace.list.filter((w) => w.id !== id)
  if (workspace.activeId === id) pick(workspace.list[0]?.id ?? '')
}
