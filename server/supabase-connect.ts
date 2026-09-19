// Connecting a Supabase project to a workspace.
//
// Two ways in. With a personal access token (supabase.com/dashboard/account/tokens)
// Alfredo lists your projects, fetches the chosen one's keys and applies
// db/schema.sql itself: one paste and done. Without one, you paste the
// project URL and its two keys, and Alfredo hands you the SQL to run once in
// the SQL editor. The token is used for the setup and then forgotten; the
// keys go to the macOS keychain.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

const API = 'https://api.supabase.com/v1'
const SCHEMA = fileURLToPath(new URL('../db/schema.sql', import.meta.url))

export type SupabaseProject = { ref: string; name: string; region: string; status: string }
export type SupabaseKeys = { url: string; anonKey: string; serviceKey: string }

export const schemaSql = () => readFileSync(SCHEMA, 'utf8')

/** The tables a workspace needs; if these answer, the schema is in. */
const PROBE = ['workspace_settings', 'pack_data', 'cards', 'docs', 'canvases', 'meetings', 'people', 'weeks']

async function call<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(API + path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
  if (r.status === 401) throw new Error('Supabase did not accept that access token.')
  if (r.status === 403) throw new Error('That access token cannot reach this project (it needs project read, API keys and database access).')
  if (!r.ok) {
    const body = await r.text().catch(() => '')
    throw new Error(`Supabase answered ${r.status}${body ? `: ${body.slice(0, 200)}` : ''}`)
  }
  const text = await r.text()
  return (text ? JSON.parse(text) : null) as T
}

export async function listProjects(token: string): Promise<SupabaseProject[]> {
  const rows = await call<any[]>(token, '/projects')
  return rows.map((p) => ({ ref: p.ref ?? p.id, name: p.name, region: p.region, status: p.status }))
}

/** The project's URL and keys. New-style keys when the project has them, legacy JWT keys otherwise. */
export async function projectKeys(token: string, ref: string): Promise<SupabaseKeys> {
  const keys = await call<any[]>(token, `/projects/${encodeURIComponent(ref)}/api-keys?reveal=true`)
  const pick = (type: string, legacy: string) =>
    keys.find((k) => k.type === type && k.api_key)?.api_key ?? keys.find((k) => k.name === legacy && k.api_key)?.api_key
  const anonKey = pick('publishable', 'anon')
  const serviceKey = pick('secret', 'service_role')
  if (!anonKey || !serviceKey) throw new Error('Could not read this project’s API keys with that token.')
  return { url: `https://${ref}.supabase.co`, anonKey, serviceKey }
}

/** Run db/schema.sql on the project. It is idempotent, so running it again only adds what is new. */
export async function applySchema(token: string, ref: string) {
  await call(token, `/projects/${encodeURIComponent(ref)}/database/query`, { method: 'POST', body: JSON.stringify({ query: schemaSql() }) })
}

/** Which of the workspace tables the project is missing (empty when set up). Throws on a wrong key. */
export async function missingTables(k: { url: string; serviceKey: string }): Promise<string[]> {
  const c = createClient(k.url, k.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const missing: string[] = []
  for (const t of PROBE) {
    const { error, status } = await c.from(t).select('*', { head: true, count: 'exact' }).limit(1)
    if (!error) continue
    // Only "no such table" means missing; anything else (a wrong key above all) is an error.
    if (status === 404 || error.code === 'PGRST205' || error.code === '42P01') missing.push(t)
    else if (status === 401 || status === 403) throw new Error('Supabase did not accept that secret (service_role) key.')
    else throw new Error(`Supabase answered: ${error.message || status}`)
  }
  return missing
}

/** Checks the browser key: the sign-in endpoint answers only to a real one. */
export async function checkAnonKey(url: string, anonKey: string) {
  const r = await fetch(`${url}/auth/v1/settings`, { headers: { apikey: anonKey } }).catch(() => null)
  if (!r) throw new Error('Could not reach that Supabase project.')
  if (r.status === 401 || r.status === 403) throw new Error('Supabase did not accept that publishable (anon) key.')
}

/** "https://abcd.supabase.co" -> "abcd". */
export const refOf = (url: string) => url.match(/^https:\/\/([a-z0-9]{20})\.supabase\.co\/?$/)?.[1] ?? null
