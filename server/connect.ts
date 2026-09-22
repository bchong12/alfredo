// Connecting a workspace to a database you own. The Settings screen and the
// MCP tools both call these, so "connect my Supabase" works the same whether
// you click through it or ask Claude to do it.

import { createClient } from '@supabase/supabase-js'
import * as ws from './workspaces'
import { CloudflareWorkspace } from './cloudflare-workspace'
import { applySchema, checkAnonKey, listProjects, missingTables, projectKeys, refOf, schemaSql, type SupabaseProject } from './supabase-connect'
import { hashToken } from './v2'
import { readInviteLink } from './invite-link'

export type SupabaseConnect = {
  name: string
  /** A personal access token: Alfredo fetches the keys and sets the tables up itself. */
  accessToken?: string
  /** Which project, when using a token. Or give `url`. */
  ref?: string
  url?: string
  anonKey?: string
  serviceKey?: string
}

export type Connected = {
  workspace: ReturnType<typeof ws.publicView>
  /** applied: Alfredo created the tables. ready: they were already there. missing: run `sql` once in the SQL editor. */
  schema: 'applied' | 'ready' | 'missing'
  missing?: string[]
  sql?: string
}

export class NeedsProject extends Error {
  constructor(public projects: SupabaseProject[]) {
    super('Pick which Supabase project this workspace uses.')
  }
}

export async function supabaseProjects(accessToken: string) {
  return listProjects(accessToken.trim())
}

export async function connectSupabase(o: SupabaseConnect): Promise<Connected> {
  const name = o.name?.trim() || 'Workspace'
  if (o.accessToken) {
    const token = o.accessToken.trim()
    const ref = o.ref?.trim() || (o.url ? refOf(o.url.trim()) : null)
    if (!ref) throw new NeedsProject(await listProjects(token))
    const keys = await projectKeys(token, ref)
    const before = await missingTables(keys)
    if (before.length) await applySchema(token, ref)
    const after = before.length ? await missingTables(keys) : []
    if (after.length) throw new Error(`The tables were not all created (${after.join(', ')}). Try again, or run the setup SQL in the SQL editor.`)
    const w = ws.createSupabase({ name, ...keys })
    return { workspace: ws.publicView(w), schema: before.length ? 'applied' : 'ready' }
  }

  const url = (o.url ?? '').trim().replace(/\/$/, '')
  if (!refOf(url)) throw new Error('Enter the project URL, https://<ref>.supabase.co (Project Settings > API).')
  if (!o.anonKey?.trim() || !o.serviceKey?.trim()) throw new Error('Paste both keys: the publishable (anon) key and the secret (service_role) key.')
  const keys = { url, anonKey: o.anonKey.trim(), serviceKey: o.serviceKey.trim() }
  await checkAnonKey(url, keys.anonKey)
  const missing = await missingTables(keys)
  const w = ws.createSupabase({ name, ...keys })
  return missing.length ? { workspace: ws.publicView(w), schema: 'missing', missing, sql: schemaSql() } : { workspace: ws.publicView(w), schema: 'ready' }
}

/** Set up (or update) the tables of a workspace already connected to Supabase. */
export async function setupSupabaseSchema(id: string, accessToken?: string): Promise<{ schema: 'applied' | 'ready' | 'missing'; missing?: string[]; sql?: string }> {
  const keys = ws.supabaseFor(id)
  if (!keys) throw new Error('That workspace is not connected to Supabase.')
  if (!keys.serviceKey) throw new Error('Only the person who set this workspace up can change its tables.')
  const ref = refOf(keys.url)!
  if (accessToken) {
    await applySchema(accessToken.trim(), ref)
    const left = await missingTables(keys)
    return left.length ? { schema: 'missing', missing: left, sql: schemaSql() } : { schema: 'applied' }
  }
  const missing = await missingTables(keys)
  return missing.length ? { schema: 'missing', missing, sql: schemaSql() } : { schema: 'ready' }
}

export async function connectCloudflare(o: { name: string; url: string; token: string }) {
  const url = (o.url ?? '').trim().replace(/\/$/, '')
  if (!/^https:\/\/[a-z0-9.-]+(\.workers\.dev|\.[a-z]{2,})$/i.test(url)) throw new Error('Enter the Worker URL, https://…')
  if (!o.token || o.token.length < 32) throw new Error('Paste the workspace API token.')
  let probe: { ok: boolean }
  try {
    probe = await new CloudflareWorkspace(url, o.token).ping()
  } catch (e) {
    throw new Error(`Could not reach that Worker: ${(e as Error).message}`)
  }
  if (!probe.ok) throw new Error('The Worker answered but did not accept that token.')
  return ws.publicView(ws.createCloudflare({ name: o.name?.trim() || 'Workspace', url, token: o.token }))
}

/**
 * Make a sign-in for a Supabase workspace. The first account in a fresh
 * project becomes its admin; after that, only emails someone invited (a row
 * in `people`) can make one. This Mac holds the project's secret key, so the
 * server creates the user directly and no confirmation email is needed.
 */
export async function createAccount(id: string, a: { email: string; password: string; name?: string }) {
  const k = ws.supabaseFor(id)
  if (!k) throw new Error('That workspace is not connected to Supabase.')
  const email = a.email.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email.')
  if ((a.password ?? '').length < 8) throw new Error('Use a password of at least 8 characters.')
  if (!k.serviceKey) throw new Error('This workspace is a membership: accounts are made by signing up, not here.')
  const admin = createClient(k.url, k.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })

  const { data: users, error: listErr } = await admin.auth.admin.listUsers({ page: 1, perPage: 1 })
  if (listErr) throw new Error(listErr.message)
  const first = users.users.length === 0
  const { data: invited } = await admin.from('people').select('id, name, role').ilike('email', email).limit(1)
  const person = invited?.[0] ?? null
  if (!first && !person) throw new Error('This workspace only lets invited people make an account. Ask an admin to invite this email in Settings > Members.')

  const name = a.name?.trim() || person?.name || email.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  const { error } = await admin.auth.admin.createUser({ email, password: a.password, email_confirm: true, user_metadata: { name } })
  if (error) throw new Error(/already/i.test(error.message) ? 'That email already has an account. Sign in instead.' : error.message)

  if (person) {
    if (first) await admin.from('people').update({ role: 'admin' }).eq('id', person.id)
  } else {
    await admin.from('people').insert({ name, email, role: 'admin', position: 0 })
  }
  return { ok: true, admin: first || person?.role === 'admin' }
}


// --- invitations ---------------------------------------------------------------

/** What a link opens, so the app knows what to ask for before using it. */
export function inspectInvite(link: string) {
  const i = readInviteLink(link)
  return { kind: i.kind, name: i.name, url: i.url }
}

/**
 * Register the workspace an invite link points at.
 *
 * A Supabase workspace connects with the publishable key and the person signs
 * in next. A Cloudflare one has its own sign-in: the Worker takes the
 * invitation (a password too, if one is offered, for signing in elsewhere)
 * and hands back the session this Mac keeps.
 */
export async function joinWithLink(link: string, o: { name?: string; password?: string } = {}) {
  const i = readInviteLink(link)
  if (i.kind === 'cloudflare') {
    const r = await fetch(`${i.url}/api/workspace/auth/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ invite: i.token!, name: o.name, password: o.password }),
    })
    const data = (await r.json().catch(() => null)) as { token?: string; error?: string } | null
    if (!r.ok || !data?.token) throw new Error(data?.error ?? `That Worker answered ${r.status}.`)
    // Someone may already hold this workspace another way (its owner, say);
    // a membership is its own connection rather than a replacement.
    const w = ws.createCloudflare({ name: i.name, url: i.url, token: data.token })
    return { workspace: ws.publicView(w), token: null, signedIn: true }
  }
  const have = ws.list().find((w) => w.kind === 'remote' && w.supabase?.url === i.url)
  const w = have ?? ws.createSupabase({ name: i.name, url: i.url, anonKey: i.anonKey! })
  // No token means no invitation to spend: they sign in as they already can.
  return { workspace: ws.publicView(w), token: i.token ?? null, signedIn: false }
}

/** Spend the invitation as the person who just signed in. */
export async function claimInvite(id: string, o: { token: string; name?: string; session: string }) {
  const k = ws.supabaseFor(id)
  if (!k) throw new Error('That workspace is not connected to Supabase.')
  if (!o.session) throw new Error('Sign in first.')
  const as = createClient(k.url, k.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${o.session}` } },
  })
  const { data, error } = await as.rpc('alfredo_join', { token_hash: await hashToken(o.token), display_name: o.name ?? null })
  if (error) throw new Error(error.message.replace(/^.*?:\s*/, ''))
  return { person: data }
}
