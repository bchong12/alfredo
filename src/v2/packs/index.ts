// Packs: tab types beyond the base four. Each pack is a folder here with an
// index.ts exporting `tabs`, keyed by the tab type a workspace's tabs JSON
// uses. Its data lives in that workspace's database (pack_data), never in
// the code. A copy of Alfredo without a pack's folder still opens the
// workspace; the tab just says the pack isn't installed.
import type { Component } from 'svelte'

export type PackView = { id: string; label: string }
export type PackTab = {
  /** Lucide icon for the sidebar. */
  icon: Component<any>
  /** Pages inside the tab, shown as a dropdown in the sidebar. */
  views: PackView[]
  component: Component<{ kind: string; tabName: string; view: string }>
}

const mods = import.meta.glob<{ tabs: Record<string, PackTab> }>('./*/index.ts', { eager: true })

export const PACK_TABS: Record<string, PackTab> = Object.assign({}, ...Object.values(mods).map((m) => m.tabs))
