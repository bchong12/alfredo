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

/** Make an account in this workspace's project, for someone holding an invite. */
export async function signUp(email: string, password: string) {
  auth.error = ''
  const c = await getClient()
  const { data, error } = await c.auth.signUp({ email, password })
  if (error) {
    auth.error = error.message
    return false
  }
  if (!data.session) {
    auth.error = 'Check your email to confirm the address, then sign in.'
    return false
  }
  auth.session = data.session
  return true
}

/** Sign in with Google, through the browser. The server holds the answer. */
export async function signInWithGoogle(workspaceId: string) {
  auth.error = ''
  try {
    const { state } = await post<{ state: string }>(`/api/workspaces/${workspaceId}/google`, {})
    for (let i = 0; i < 300; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      const r = await api<{ status: string; error?: string; session?: { access_token: string; refresh_token: string } }>(
        `/api/workspaces/${workspaceId}/google/${state}`,
      )
      if (r.status === 'failed') {
        auth.error = r.error ?? 'Google did not sign you in.'
        return false
      }
      if (r.status === 'done' && r.session) {
        const c = await getClient()
        const { data, error } = await c.auth.setSession(r.session)
        if (error) {
          auth.error = error.message
          return false
        }
        auth.session = data.session
        return true
      }
      if (r.status === 'unknown') return false
    }
    auth.error = 'That took too long. Try again.'
    return false
  } catch (e) {
    auth.error = (e as Error).message
    return false
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

/**
 * A 401 means the session this request carried is no good. Only that one:
 * switching workspaces, a request can leave with no session (or the last
 * workspace's) and come back after the right one has been found, and that
 * answer used to sign the person out of the workspace they had just entered.
 */
function expired(sent: string | null) {
  const now = auth.session?.access_token ?? null
  if (sent && sent === now) auth.session = null
}

/** POST for the REST API. Same session handling as api(). */
export async function post<T>(path: string, body: unknown, method = 'POST', extra: Record<string, string> = {}): Promise<T> {
  const sent = auth.session?.access_token ?? null
  const r = await fetch(apiUrl(path), {
    method,
    headers: { 'Content-Type': 'application/json', ...apiHeaders(), ...extra },
    body: JSON.stringify(body),
  })
  if (r.status === 401) {
    expired(sent)
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
  const sent = auth.session?.access_token ?? null
  const r = await fetch(apiUrl(path), { headers: { ...apiHeaders(), ...extra } })
  if (r.status === 401) {
    expired(sent)
    throw new Error('session expired')
  }
  if (!r.ok) throw new Error(`${path} failed (${r.status})`)
  return r.json() as Promise<T>
}
