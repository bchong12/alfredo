// Auth state plus an authenticated fetch. Every view calls api() rather than
// fetch() so a expired token surfaces as a sign-in prompt, not a blank screen.

import { createClient, type SupabaseClient, type Session } from '@supabase/supabase-js'
import { workspace } from './workspace.svelte'

/**
 * Empty in development, where Vite proxies /api and /config to the local
 * server. In the deployed build this points at the Supabase Edge Function,
 * because the site is static and has no backend of its own.
 */
const BASE = import.meta.env.VITE_API_BASE ?? ''
export const apiUrl = (path: string) => `${BASE}${path}`

/** One client per Supabase project: each workspace can live in its own. */
const clients = new Map<string, SupabaseClient>()
let client: SupabaseClient | null = null

export const auth = $state({
  session: null as Session | null,
  ready: false,
  error: '',
  /** The workspace the session above belongs to, so a switch never shows the last one's sign-in state. */
  for: null as string | null,
})

export const person = () => {
  const u = auth.session?.user
  if (!u) return null
  return {
    id: u.id,
    email: u.email ?? '',
    name: (u.user_metadata?.name as string) ?? u.email?.split('@')[0] ?? 'Unknown',
  }
}

/** The same client the auth flow uses, for Storage calls from the browser. */
export const supabase = () => getClient()

async function getClient() {
  if (client) return client
  const ws = workspace.activeId
  const cfg = await (await fetch(apiUrl(`/config${ws ? `?ws=${encodeURIComponent(ws)}` : ''}`))).json()
  if (!cfg.supabaseUrl || !cfg.supabaseKey) throw new Error('This machine has no shared workspace configured.')
  let c = clients.get(cfg.supabaseUrl)
  if (!c) {
    const made = createClient(cfg.supabaseUrl, cfg.supabaseKey)
    made.auth.onAuthStateChange((_e, s) => {
      if (client === made) auth.session = s
    })
    clients.set(cfg.supabaseUrl, made)
    c = made
  }
  client = c
  return c
}

/** True once /config says a Supabase project exists to sign in to. */
export const remote = $state({ available: false })

/** Find the session for the active workspace's project. Runs at start and on every workspace switch. */
export async function boot() {
  const ws = workspace.activeId
  client = null
  try {
    const c = await getClient()
    remote.available = true
    const { data } = await c.auth.getSession()
    if (workspace.activeId !== ws) return
    auth.session = data.session
  } catch {
    // No Supabase for this workspace: nothing to sign in to.
    if (workspace.activeId !== ws) return
    remote.available = false
    auth.session = null
  }
  auth.for = ws
  auth.ready = true
}

/** Headers every REST call carries: the session, and which workspace. */
export function apiHeaders(): Record<string, string> {
  const token = auth.session?.access_token
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(workspace.activeId ? { 'x-workspace': workspace.activeId } : {}),
  }
}

export async function signIn(email: string, password: string) {
  auth.error = ''
  const c = await getClient()
  const { data, error } = await c.auth.signInWithPassword({ email, password })
  if (error) {
    // Supabase says "Invalid login credentials" for both a wrong password and
    // an unknown address, which is correct and worth keeping.
    auth.error = error.message
    return false
  }
  auth.session = data.session
  return true
}

export async function signOut() {
  const c = await getClient()
  await c.auth.signOut()
  auth.session = null
}

/** POST for the REST API. Same session handling as api(). */
export async function post<T>(path: string, body: unknown, method = 'POST', extra: Record<string, string> = {}): Promise<T> {
  const r = await fetch(apiUrl(path), {
    method,
    headers: { 'Content-Type': 'application/json', ...apiHeaders(), ...extra },
    body: JSON.stringify(body),
  })
  if (r.status === 401) {
    auth.session = null
    throw new Error('session expired')
  }
  if (!r.ok) {
    const detail = await r.json().catch(() => null)
    throw new Error(detail?.error ?? `${path} failed (${r.status})`)
  }
  return r.json() as Promise<T>
}

/** fetch for the REST API, carrying the session and handling its expiry. */
export async function api<T>(path: string, extra: Record<string, string> = {}): Promise<T> {
  const r = await fetch(apiUrl(path), { headers: { ...apiHeaders(), ...extra } })
  if (r.status === 401) {
    auth.session = null
    throw new Error('session expired')
  }
  if (!r.ok) throw new Error(`${path} failed (${r.status})`)
  return r.json() as Promise<T>
}
