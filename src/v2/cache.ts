// Stale-while-revalidate for the v2 API. Every list and item remembers the
// last answer per workspace, so switching tabs, weeks or docs draws at once
// from memory while the fresh copy loads behind it. Writes update the cache
// first (optimistic) and roll back if the server says no.
//
// The memory copy is mirrored to this browser's storage, so the answer
// survives a reload and a restart: opening Alfredo draws the board you left
// rather than an empty page with a spinner over it. What is drawn from there
// is always checked against the server in the background, and anything large
// (a canvas full of nodes) stays in memory only.
import { v2 } from './api'
import { workspace } from '../lib/workspace.svelte'
import { scope } from './project.svelte'

const store = new Map<string, unknown>()
const inflight = new Map<string, Promise<unknown>>()
// Lists differ per project, so the open project is part of the key.
const key = (path: string) => `${workspace.activeId}|${scope.enabled ? (scope.id ?? 'all') : ''}|${path}`

// --- the copy on disk ---------------------------------------------------------

const DISK = 'alfredo.cache.v1.'
/** Big answers are not worth a storage quota; they stay in memory for the session. */
const BIGGEST = 180_000
/** Roughly a few megabytes in all, oldest thrown away first. */
const ROOM = 3_500_000

type Index = Record<string, { n: number; at: number }>
let index: Index = read(DISK + 'index') ?? {}

function read<T>(k: string): T | null {
  try {
    const raw = localStorage.getItem(k)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function saveIndex() {
  try {
    localStorage.setItem(DISK + 'index', JSON.stringify(index))
  } catch {}
}

/** Throw away the oldest until what is kept fits. */
function makeRoom(want: number) {
  let used = Object.values(index).reduce((a, e) => a + e.n, 0)
  if (used + want <= ROOM) return
  for (const [k] of Object.entries(index).sort((a, b) => a[1].at - b[1].at)) {
    used -= index[k].n
    delete index[k]
    try {
      localStorage.removeItem(DISK + k)
    } catch {}
    if (used + want <= ROOM) break
  }
}

function keep(k: string, value: unknown) {
  let text: string
  try {
    text = JSON.stringify(value)
  } catch {
    return
  }
  if (!text || text.length > BIGGEST) return
  makeRoom(text.length)
  try {
    localStorage.setItem(DISK + k, text)
    index[k] = { n: text.length, at: Date.now() }
    saveIndex()
  } catch {
    // Out of room even after making some: drop everything and carry on from
    // memory. A cache that cannot be written is not a reason to fail a read.
    forgetDisk()
  }
}

function recall(k: string): unknown {
  if (!index[k]) return undefined
  const v = read<unknown>(DISK + k)
  if (v === null) {
    delete index[k]
    saveIndex()
    return undefined
  }
  store.set(k, v)
  return v
}

/** Empty the copy on disk (a sign-out, or a workspace nobody can read any more). */
export function forgetDisk(prefix = '') {
  for (const k of Object.keys(index)) {
    if (prefix && !k.startsWith(prefix)) continue
    delete index[k]
    try {
      localStorage.removeItem(DISK + k)
    } catch {}
  }
  saveIndex()
}

// --- the cache ----------------------------------------------------------------

export function peek<T>(path: string): T | undefined {
  const k = key(path)
  const have = store.get(k)
  return (have !== undefined ? have : recall(k)) as T | undefined
}

export function put<T>(path: string, value: T) {
  const k = key(path)
  store.set(k, value)
  keep(k, value)
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
      keep(k, v)
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

/**
 * Ask again even when there is an answer already, so what is on screen is
 * replaced by the truth a moment later. Used for the lists a tab shows the
 * instant it opens.
 */
export function refresh(path: string) {
  load(path).catch(() => {})
}

export function drop(prefix: string) {
  const k = key(prefix)
  for (const s of [...store.keys()]) if (s.startsWith(k)) store.delete(s)
  for (const s of Object.keys(index)) {
    if (!s.startsWith(k)) continue
    delete index[s]
    try {
      localStorage.removeItem(DISK + s)
    } catch {}
  }
  saveIndex()
}

/** The lists behind each kind of tab, for warming one before it is opened. */
export const TAB_PATHS: Record<string, string[]> = {
  board: ['/weeks'],
  docs: ['/docs'],
  canvas: ['/canvases'],
  meetings: ['/meetings'],
}

/** Warm every tab of the workspace, once the one on screen has drawn. */
export function warmTabs(types: string[]) {
  const paths = [...new Set(types.flatMap((t) => TAB_PATHS[t] ?? []))]
  const idle = (fn: () => void) =>
    typeof requestIdleCallback === 'function' ? requestIdleCallback(fn, { timeout: 1200 }) : setTimeout(fn, 300)
  idle(() => paths.forEach(prefetch))
}
