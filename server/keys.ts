// Each person brings their own OpenRouter key.
//
// The alternative, one key in the environment, meant every transcription in the
// workspace was billed to whoever set the server up, silently and with no way
// to see it. Per-person keys make the spend legible and stop one person's long
// meeting from draining someone else's credit.
//
// There is deliberately no fallback to the environment key. A fallback would
// restore exactly the behaviour this replaces, except harder to notice.

import { db } from './db'
import { env } from './env'
import { LOCAL_USER } from './local-user'
import { hasLocalChat } from './ai'

/**
 * The key for work with no signed-in person behind it: the MCP endpoint and the
 * microphone on the machine running the server, both of which are loopback-only
 * and belong to whoever set this up. Everything reached through a browser goes
 * through keyFor() instead, and is billed to the person who asked for it.
 */
export function localKey() {
  const k = env('OPENROUTER_API_KEY')
  if (!k) throw new Error('OPENROUTER_API_KEY is not set')
  return k
}

export class NoKeyError extends Error {
  constructor() {
    super('No OpenRouter key. Add one in Settings before recording.')
    this.name = 'NoKeyError'
  }
}

/**
 * Asks OpenRouter whether the key works, and what to call it.
 *
 * Worth the round trip: a mistyped key that is only discovered when the first
 * segment fails means finding out after the meeting, which is the one time it
 * cannot be fixed.
 */
export async function checkKey(key: string) {
  const r = await fetch('https://openrouter.ai/api/v1/key', {
    headers: { Authorization: `Bearer ${key}` },
  })
  if (r.status === 401) throw new Error('OpenRouter rejected that key.')
  if (!r.ok) throw new Error(`Could not reach OpenRouter (${r.status}). Try again.`)

  const { data } = (await r.json()) as {
    data?: { label?: string; usage?: number; limit_remaining?: number | null }
  }
  return {
    // The provider's own masked form, e.g. "sk-or-v1-d7e...6cf". Safe to show
    // and enough to tell two keys apart.
    hint: data?.label ?? 'sk-or-…',
    usage: data?.usage ?? 0,
    remaining: data?.limit_remaining ?? null,
  }
}

export async function setKey(userId: string, key: string) {
  const info = await checkKey(key.trim())
  const { error } = await db.from('user_keys').upsert({
    user_id: userId,
    key: key.trim(),
    hint: info.hint,
    updated_at: new Date().toISOString(),
  })
  if (error) throw new Error(error.message)
  return info
}

export async function clearKey(userId: string) {
  await db.from('user_keys').delete().eq('user_id', userId)
}

/** What the browser is allowed to know: that there is one, and which one. */
export async function keyStatus(userId: string) {
  if (hasLocalChat()) return { hasKey: true, hint: 'Claude Code on this Mac', local: true }
  const { data } = await db.from('user_keys').select('hint').eq('user_id', userId).single()
  if (data) return { hasKey: true, hint: (data.hint as string) ?? null, local: false }
  // The environment key counts for a local workspace, the same as keyFor().
  if (userId === LOCAL_USER.id && env('OPENROUTER_API_KEY')) return { hasKey: true, hint: 'from .env.local', local: false }
  return { hasKey: false, hint: null, local: false }
}

/** The key itself. Server-side only; never goes near a response body. */
export async function keyFor(userId: string | null | undefined) {
  // Write-ups run on this Mac through Claude Code: nothing to bill, no key.
  if (hasLocalChat()) return ''
  if (!userId) throw new NoKeyError()
  const { data } = await db.from('user_keys').select('key').eq('user_id', userId).single()
  const key = data?.key as string | undefined
  if (key) return key
  // A local workspace is your own machine, so the key in its environment is
  // yours. This is the one place the environment stands in for a person.
  if (userId === LOCAL_USER.id) {
    const k = env('OPENROUTER_API_KEY')
    if (k) return k
  }
  throw new NoKeyError()
}
