// What this Mac remembers about workspaces you have already opened, so the
// app draws them at once instead of waiting for a database to answer.
//
// Two things: how each workspace looks (its name and logo), and the faces of
// the people you have seen. A workspace's own answer always wins; this is
// only what to show until it arrives, and for the places a photo was never
// uploaded. Nothing here is the truth, so losing it costs a redraw.

import type { Person } from './api'

type Brand = { name?: string; logo?: string | null }

const BRANDS = 'alfredo.brands'
const FACES = 'alfredo.faces'
/** Enough for the people and workspaces anyone actually switches between. */
const FACE_LIMIT = 40

function read<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '') ?? fallback
  } catch {
    return fallback
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // A full or blocked store only means the next draw waits for the server.
  }
}

export const brands = $state<Record<string, Brand>>(read(BRANDS, {}))
export const faces = $state<Record<string, string>>(read(FACES, {}))

/** Remember how a workspace looks, from its settings. */
export function rememberBrand(id: string, b: Brand) {
  if (!id) return
  const have = brands[id]
  if (have?.name === b.name && have?.logo === (b.logo ?? null)) return
  brands[id] = { name: b.name, logo: b.logo ?? null }
  write(BRANDS, brands)
}

export const brandOf = (id: string): Brand => brands[id] ?? {}

export function forgetBrand(id: string) {
  delete brands[id]
  write(BRANDS, brands)
}

/**
 * Remember the photos of people you have seen, by email, so the same person
 * has a face in every workspace. One that has its own photo for them keeps it.
 */
export function rememberFaces(people: Person[]) {
  let changed = false
  for (const p of people) {
    const key = p.email?.toLowerCase()
    if (!key || !p.avatar || faces[key] === p.avatar) continue
    faces[key] = p.avatar
    changed = true
  }
  if (!changed) return
  const keys = Object.keys(faces)
  for (const old of keys.slice(0, Math.max(0, keys.length - FACE_LIMIT))) delete faces[old]
  write(FACES, faces)
}

/** Their photo here, else the one they have anywhere else, else nothing. */
export const avatarOf = (p: Person | null | undefined): string | null => {
  if (!p) return null
  if (p.avatar) return p.avatar
  const key = p.email?.toLowerCase()
  return (key && faces[key]) || null
}
