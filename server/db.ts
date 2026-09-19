import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { env } from './env'

/*
 * `db` is whichever database the current request is talking to.
 *
 * Every route, MCP tool and pipeline imports `db` and calls it like a
 * supabase-js client. On the deployed edge function that is exactly what it
 * is. In Alfredo it depends on the workspace: a Supabase workspace is the same
 * Supabase project, and a personal workspace is Postgres on disk speaking the
 * same dialect (see local-db.ts). The Node entry installs a resolver that
 * reads the workspace off the request; nothing else in the codebase knows
 * there are two.
 *
 * A Proxy rather than a function so the ~110 existing `db.from(...)` calls
 * stay as they are. Property reads are forwarded to whichever client the
 * resolver returns right now.
 */

// Untyped tables on purpose: the routes were written against the loose
// client and the local adapter matches that shape, not a generated one.
type Client = SupabaseClient<any, 'public', any>

let remote: Client | null = null

/** The Supabase project in the environment, created lazily so a laptop with no
 *  .env.local can still open local workspaces. */
export function remoteDb(): Client {
  if (remote) return remote
  const url = env('SUPABASE_URL')
  const key = env('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !key) {
    throw new Error(
      'This workspace syncs to Supabase, but SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are not set.',
    )
  }
  remote = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  return remote
}

let resolver: () => unknown = () => remoteDb()

/** Installed once by the Node entry; the edge never calls it. */
export function setDbResolver(fn: () => unknown) {
  resolver = fn
}

export const db = new Proxy({} as Client, {
  get(_t, prop) {
    const target = resolver() as any
    const v = target[prop]
    return typeof v === 'function' ? v.bind(target) : v
  },
})

/** Throws on error so every caller does not repeat the same three lines. */
export async function one<T>(q: PromiseLike<{ data: T | null; error: { message: string } | null }>) {
  const { data, error } = await q
  if (error) throw new Error(error.message)
  if (!data) throw new Error('not found')
  return data
}

export async function many<T>(q: PromiseLike<{ data: T[] | null; error: { message: string } | null }>) {
  const { data, error } = await q
  if (error) throw new Error(error.message)
  return data ?? []
}

/**
 * Fractional index between two neighbours. Moving a card rewrites one row
 * instead of renumbering the whole column.
 */
export function positionBetween(before: number | null, after: number | null) {
  if (before == null && after == null) return 1
  if (before == null) return after! - 1
  if (after == null) return before + 1
  return (before + after) / 2
}
