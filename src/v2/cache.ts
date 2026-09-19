// Stale-while-revalidate for the v2 API. Every list and item remembers the
// last answer per workspace, so switching tabs, weeks or docs draws at once
// from memory while the fresh copy loads behind it. Writes update the cache
// first (optimistic) and roll back if the server says no.
import { v2 } from './api'
import { workspace } from '../lib/workspace.svelte'
import { scope } from './project.svelte'

const store = new Map<string, unknown>()
const inflight = new Map<string, Promise<unknown>>()
// Lists differ per project, so the open project is part of the key.
const key = (path: string) => `${workspace.activeId}|${scope.enabled ? (scope.id ?? 'all') : ''}|${path}`

export function peek<T>(path: string): T | undefined {
  return store.get(key(path)) as T | undefined
}

export function put<T>(path: string, value: T) {
  store.set(key(path), value)
}

/** Fetch fresh, dedupe concurrent calls, remember the answer. */
export function load<T>(path: string): Promise<T> {
  const k = key(path)
  const have = inflight.get(k)
  if (have) return have as Promise<T>
  const p = v2
    .get<T>(path)
    .then((v) => {
      store.set(k, v)
      return v
    })
    .finally(() => inflight.delete(k))
  inflight.set(k, p)
  return p
}

/** Warm the cache without waiting (neighbouring weeks, the next doc). */
export function prefetch(path: string) {
  if (!store.has(key(path))) load(path).catch(() => {})
}

export function drop(prefix: string) {
  const k = key(prefix)
  for (const s of [...store.keys()]) if (s.startsWith(k)) store.delete(s)
}
