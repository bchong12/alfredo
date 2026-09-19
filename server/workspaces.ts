// Workspaces: which database a request talks to.
//
// A workspace is a folder on this machine, a Supabase project, or a
// Cloudflare D1 behind a Worker. Personal ones are folders; shared ones live
// in a database you own. Nothing else about the app changes between them -- the
// same routes, the same MCP tools, the same UI -- because local-db.ts speaks
// the dialect the routes were already written in.
//
// The registry lives in ~/.alfredo/workspaces.json; each local workspace's data
// lives under ~/.alfredo/workspaces/<id>/. Copying that folder is a backup.

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LocalDb } from './local-db'
import { createClient } from '@supabase/supabase-js'
import { remoteDb } from './db'
import { env } from './env'
import { appHome } from './home'
import { CloudflareWorkspace } from './cloudflare-workspace'
import { getSecret, setSecret, deleteSecret } from './keychain'

export type Workspace = {
  id: string
  name: string
  kind: 'local' | 'remote' | 'cloudflare'
  /** Where a Cloudflare workspace's API lives. Its token is in the keychain. */
  cloudflare?: { url: string } | null
  /**
   * The Supabase project behind a remote workspace. Its keys are in the
   * keychain. Absent on a workspace made from SUPABASE_URL and friends in
   * the environment (the original setup), which keeps reading them there.
   */
  supabase?: { url: string } | null
  /** Repositories that belong to this workspace, for terminal sessions. */
  repos: string[]
  /** Card refs: PEA-12. Three letters of the name unless set. */
  prefix?: string
  /** Canvas LMS, for pulling assignments onto the board. */
  canvas?: { baseUrl: string; token: string } | null
  /** Composio: which connected account (by alias) each app uses here. */
  composio?: Record<string, string>
  /** Scheduled headless Claude runs that can use those connections. */
  automations?: Automation[]
  createdAt: string
}

export type Automation = {
  id: string
  name: string
  prompt: string
  every: 'manual' | 'hourly' | 'daily'
  lastRunAt?: string
  lastStatus?: 'ok' | 'failed' | 'running'
  lastOutput?: string
}

type Registry = { active: string | null; workspaces: Workspace[] }

export const HOME = env('ALFREDO_HOME') ?? env('ALFRED_HOME') ?? appHome()
const FILE = join(HOME, 'workspaces.json')
const SCHEMA = fileURLToPath(new URL('../db/schema.sql', import.meta.url))

function read(): Registry {
  if (!existsSync(FILE)) return { active: null, workspaces: [] }
  try {
    return JSON.parse(readFileSync(FILE, 'utf8')) as Registry
  } catch {
    return { active: null, workspaces: [] }
  }
}

function write(r: Registry) {
  mkdirSync(HOME, { recursive: true })
  writeFileSync(FILE, JSON.stringify(r, null, 2) + '\n')
}

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'workspace'

/**
 * If this machine has Supabase credentials, the shared workspace exists
 * without anyone creating it. A laptop without them simply never sees it.
 */
export function ensureDefaults() {
  const r = read()
  const hasRemote = !!env('SUPABASE_URL') && !!env('SUPABASE_SERVICE_ROLE_KEY')
  if (hasRemote && !r.workspaces.some((w) => w.kind === 'remote')) {
    r.workspaces.unshift({
      id: slug(env('ALFRED_REMOTE_NAME') ?? 'Shared'),
      name: env('ALFRED_REMOTE_NAME') ?? 'Shared',
      kind: 'remote',
      repos: [],
      createdAt: new Date().toISOString(),
    })
  }
  if (!r.active && r.workspaces.length) r.active = r.workspaces[0].id
  write(r)
  return r
}

export const list = () => read().workspaces
export const active = () => {
  const r = read()
  return r.workspaces.find((w) => w.id === r.active) ?? r.workspaces[0] ?? null
}
export const get = (id: string) => read().workspaces.find((w) => w.id === id) ?? null

export function create(opts: { name: string; repos?: string[] }) {
  const r = read()
  let id = slug(opts.name)
  for (let i = 2; r.workspaces.some((w) => w.id === id); i++) id = `${slug(opts.name)}-${i}`
  const ws: Workspace = {
    id,
    name: opts.name.trim() || 'Workspace',
    kind: 'local',
    repos: opts.repos ?? [],
    createdAt: new Date().toISOString(),
  }
  r.workspaces.push(ws)
  if (!r.active) r.active = id
  write(r)
  return ws
}

export function update(id: string, patch: Partial<Pick<Workspace, 'name' | 'repos' | 'prefix' | 'canvas' | 'composio' | 'automations'>>) {
  const r = read()
  const ws = r.workspaces.find((w) => w.id === id)
  if (!ws) return null
  if (patch.name?.trim()) ws.name = patch.name.trim()
  if (patch.repos) ws.repos = patch.repos
  if (patch.prefix !== undefined) ws.prefix = patch.prefix?.trim().toUpperCase().slice(0, 4) || undefined
  if (patch.canvas !== undefined) ws.canvas = patch.canvas
  if (patch.composio !== undefined) ws.composio = patch.composio
  if (patch.automations !== undefined) ws.automations = patch.automations
  write(r)
  return ws
}

/** What the browser may see: everything but secrets. */
export const publicView = (w: Workspace) => ({
  ...w,
  canvas: w.canvas ? { baseUrl: w.canvas.baseUrl, token: '' , connected: true } : null,
})

export function setActive(id: string) {
  const r = read()
  if (!r.workspaces.some((w) => w.id === id)) return null
  r.active = id
  write(r)
  return get(id)
}

/** Connect a workspace that lives behind a Cloudflare Worker. */
export function createCloudflare(opts: { name: string; url: string; token: string; id?: string }) {
  const r = read()
  let id = opts.id ?? slug(opts.name)
  if (r.workspaces.some((w) => w.id === id)) {
    for (let i = 2; r.workspaces.some((w) => w.id === id); i++) id = `${slug(opts.name)}-${i}`
  }
  setSecret(`cloudflare:${id}`, opts.token)
  const ws: Workspace = {
    id,
    name: opts.name.trim() || 'Workspace',
    kind: 'cloudflare',
    cloudflare: { url: opts.url.replace(/\/$/, '') },
    repos: [],
    createdAt: new Date().toISOString(),
  }
  r.workspaces.push(ws)
  write(r)
  return ws
}

/** Connect a workspace to its own Supabase project. Keys go to the keychain. */
export function createSupabase(opts: { name: string; url: string; anonKey: string; serviceKey: string; id?: string }) {
  const r = read()
  let id = opts.id ?? slug(opts.name)
  if (r.workspaces.some((w) => w.id === id)) {
    for (let i = 2; r.workspaces.some((w) => w.id === id); i++) id = `${slug(opts.name)}-${i}`
  }
  setSecret(`supabase:${id}`, JSON.stringify({ anonKey: opts.anonKey, serviceKey: opts.serviceKey }))
  const ws: Workspace = {
    id,
    name: opts.name.trim() || 'Workspace',
    kind: 'remote',
    supabase: { url: opts.url.replace(/\/$/, '') },
    repos: [],
    createdAt: new Date().toISOString(),
  }
  r.workspaces.push(ws)
  write(r)
  return ws
}

/** A remote workspace's Supabase URL and keys: its own, or the environment's for the original one. */
export function supabaseFor(id: string): { url: string; anonKey: string; serviceKey: string } | null {
  const ws = get(id)
  if (!ws || ws.kind !== 'remote') return null
  if (ws.supabase?.url) {
    const raw = getSecret(`supabase:${id}`)
    if (!raw) return null
    try {
      const k = JSON.parse(raw)
      return { url: ws.supabase.url, anonKey: k.anonKey, serviceKey: k.serviceKey }
    } catch {
      return null
    }
  }
  const url = env('SUPABASE_URL')
  const serviceKey = env('SUPABASE_SERVICE_ROLE_KEY')
  const anonKey = env('SUPABASE_PUBLISHABLE_KEY') ?? env('SUPABASE_ANON_KEY')
  return url && serviceKey ? { url, serviceKey, anonKey: anonKey ?? '' } : null
}

const remotes = new Map<string, unknown>()
/** One service-role client per remote workspace. */
function remoteDbFor(id: string) {
  const ws = get(id)
  if (!ws?.supabase?.url) return remoteDb()
  const have = remotes.get(id)
  if (have) return have
  const k = supabaseFor(id)
  if (!k) throw new Error('This workspace has lost its Supabase keys. Reconnect it in Settings > Database.')
  const client = createClient(k.url, k.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  remotes.set(id, client)
  return client
}

export async function remove(id: string) {
  const r = read()
  const ws = r.workspaces.find((w) => w.id === id)
  if (!ws) return false
  // A workspace made from the environment would only come back on the next start.
  if (ws.kind === 'remote' && !ws.supabase) return false
  if (ws.kind === 'cloudflare' || ws.kind === 'remote') {
    // Forgetting a connection never touches the database itself.
    deleteSecret(`${ws.kind === 'remote' ? 'supabase' : 'cloudflare'}:${id}`)
    cloudflare.delete(id)
    remotes.delete(id)
    r.workspaces = r.workspaces.filter((w) => w.id !== id)
    if (r.active === id) r.active = r.workspaces[0]?.id ?? null
    write(r)
    return true
  }
  r.workspaces = r.workspaces.filter((w) => w.id !== id)
  if (r.active === id) r.active = r.workspaces[0]?.id ?? null
  write(r)
  const open = opened.get(id)
  if (open) {
    await open.close().catch(() => {})
    opened.delete(id)
  }
  rmSync(dir(id), { recursive: true, force: true })
  return true
}

export const dir = (id: string) => join(HOME, 'workspaces', id)

const opened = new Map<string, LocalDb>()
const cloudflare = new Map<string, CloudflareWorkspace>()

/** The API client for a Cloudflare workspace, or null when its token is gone. */
export function cloudflareFor(id: string): CloudflareWorkspace | null {
  const ws = get(id)
  if (!ws || ws.kind !== 'cloudflare' || !ws.cloudflare) return null
  const have = cloudflare.get(id)
  if (have) return have
  const token = getSecret(`cloudflare:${id}`)
  if (!token) return null
  const client = new CloudflareWorkspace(ws.cloudflare.url, token)
  cloudflare.set(id, client)
  return client
}
const opening = new Map<string, Promise<LocalDb>>()

/** The database behind a workspace. Local ones open once and stay open. */
export async function dbFor(id: string): Promise<unknown> {
  const ws = get(id)
  if (!ws) throw new Error(`no such workspace: ${id}`)
  if (ws.kind === 'remote') return remoteDbFor(id)
  if (ws.kind === 'cloudflare') return cloudflareFor(id)
  const have = opened.get(id)
  if (have) return have
  let p = opening.get(id)
  if (!p) {
    p = LocalDb.open(dir(id), readFileSync(SCHEMA, 'utf8')).then(async (d) => {
      await seedOwner(d).catch(() => {})
      opened.set(id, d)
      opening.delete(id)
      return d
    })
    opening.set(id, p)
  }
  return p
}

/** Who is at this Mac: git's name and email if set, else the login name. */
function macUser(): { name: string; email: string | null } {
  const git = (k: string) => {
    try {
      return execFileSync('git', ['config', '--global', k], { encoding: 'utf8', timeout: 2000 }).trim() || null
    } catch {
      return null
    }
  }
  const login = userInfo().username
  return { name: git('user.name') ?? login.charAt(0).toUpperCase() + login.slice(1), email: git('user.email') }
}

/** A local workspace starts with you in it, as its admin. */
async function seedOwner(d: LocalDb) {
  const db = d as any
  const { data } = await db.from('people').select('id').limit(1)
  if (data?.length) return
  const me = macUser()
  await db.from('people').insert({ name: me.name, email: me.email, role: 'admin', position: 0 })
}

export async function closeAll() {
  for (const d of opened.values()) await d.close().catch(() => {})
  opened.clear()
}
