// Tabs this copy of Alfredo does not carry, shown from where they live.
//
// A pack is code, and a team's own pack (its marketing library, its numbers)
// is not in everyone's copy of the app. When the workspace says where such a
// tab is served, in pack data "<type>.tab", the app shows that page in the
// tab instead of saying the pack is missing:
//
//   { "site": "https://crm.example.com", "icon": "megaphone",
//     "views": [{ "id": "inspiration", "label": "Inspiration" }] }
//
// The page gets the session this app already has, so nobody signs in twice.
import { v2 } from './api'
import { PACK_TABS, type PackView } from './packs'
import { workspace } from '../lib/workspace.svelte'

export type HostedTab = { site: string; views: PackView[]; icon?: string }

const BASE = new Set(['board', 'docs', 'canvas', 'meetings'])
const KEY = (ws: string) => `alfredo.v2.hosted.${ws}`

/** By tab type, for the workspace that is open. null: asked, and it has none. */
export const hosted = $state({ tabs: {} as Record<string, HostedTab | null>, for: '' })

/** Only a real web address, and only over https (or this machine, for building one). */
function siteOf(v: unknown): string | null {
  if (typeof v !== 'string') return null
  try {
    const u = new URL(v)
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1'
    return u.protocol === 'https:' || (u.protocol === 'http:' && local) ? u.origin : null
  } catch {
    return null
  }
}

function read(v: any): HostedTab | null {
  const site = siteOf(v?.site)
  if (!site) return null
  const views: PackView[] = Array.isArray(v.views)
    ? v.views.filter((x: any) => x && typeof x.id === 'string' && typeof x.label === 'string').map((x: any) => ({ id: x.id, label: x.label }))
    : []
  return { site, views, ...(typeof v.icon === 'string' ? { icon: v.icon } : {}) }
}

/** What was found last time, so the sidebar draws the tab as it will be. */
export function recallHosted(ws: string) {
  hosted.for = ws
  try {
    const seen = JSON.parse(localStorage.getItem(KEY(ws)) ?? '{}')
    hosted.tabs = Object.fromEntries(Object.entries(seen).map(([t, v]) => [t, v ? read(v) : null]))
  } catch {
    hosted.tabs = {}
  }
}

/** Ask the workspace where each tab this copy does not carry is served. */
export async function findHosted(types: string[]) {
  const ws = workspace.activeId
  if (hosted.for !== ws) recallHosted(ws)
  // The site that serves them carries them; it has nothing to look for.
  if (workspace.hosted) return
  const missing = [...new Set(types)].filter((t) => !BASE.has(t) && !PACK_TABS[t])
  if (!missing.length) return
  const found = await Promise.all(
    missing.map(async (t) => [t, await v2.get<unknown>(`/packs/${t}.tab`).then(read, () => null)] as const),
  )
  if (workspace.activeId !== ws) return
  hosted.tabs = { ...hosted.tabs, ...Object.fromEntries(found) }
  try {
    localStorage.setItem(KEY(ws), JSON.stringify(hosted.tabs))
  } catch {}
}

/** The pages inside a tab: the pack's own when this copy has it, else what the workspace lists. */
export const viewsOf = (type: string): PackView[] => PACK_TABS[type]?.views ?? hosted.tabs[type]?.views ?? []
