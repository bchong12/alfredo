// Session checking for the REST API the UI talks to.
//
// The MCP endpoint is deliberately NOT behind this. It is loopback-only with
// Origin and Host guards, and Claude connects to it as you, with no browser
// session to present. The browser API is different: once more than one person
// has an account, "bound to localhost" stops being an access control.

import type { Context, Next } from 'hono'
import { createClient } from '@supabase/supabase-js'
import { required } from './env'

/** Which Supabase project a token belongs to. Omitted: the one in the environment. */
export type Project = { url: string; serviceKey: string }

// Created on first use, one per project: a laptop with only local workspaces never needs one.
const verifiers = new Map<string, ReturnType<typeof createClient>>()
function getVerifier(p?: Project) {
  const url = p?.url ?? required('SUPABASE_URL')
  let v = verifiers.get(url)
  if (!v) {
    v = createClient(url, p?.serviceKey ?? required('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    verifiers.set(url, v)
  }
  return v
}

export type Person = { id: string; email: string; name: string }

/**
 * Verifying a token means a round trip to Supabase, which is far too slow to
 * repeat on every poll. Tokens are valid for an hour, so a short cache costs
 * nothing in correctness and removes the round trip from almost every request.
 */
const CACHE_MS = 60_000
const cache = new Map<string, { person: Person; at: number }>()

export async function whoIs(token: string, project?: Project): Promise<Person | null> {
  // A token from one project must not pass as a session in another.
  const key = `${project?.url ?? ''}|${token}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.person

  const { data, error } = await getVerifier(project).auth.getUser(token)
  if (error || !data.user) {
    cache.delete(key)
    return null
  }

  const person: Person = {
    id: data.user.id,
    email: data.user.email ?? '',
    name: (data.user.user_metadata?.name as string) ?? data.user.email?.split('@')[0] ?? 'Unknown',
  }
  cache.set(key, { person, at: Date.now() })
  return person
}

export async function requireSession(c: Context, next: Next, project?: Project) {
  const header = c.req.header('authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (!token) return c.json({ error: 'not signed in' }, 401)

  const person = await whoIs(token, project)
  if (!person) return c.json({ error: 'session expired' }, 401)

  c.set('person', person)
  await next()
}
