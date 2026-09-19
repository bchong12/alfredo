// Where the v2 UI is: which tab, which item inside it, which overlay.
import { v2, type Person, type Settings, type TabDef } from './api'
import { scope, rememberProject, recallProject, type Project } from './project.svelte'
import { PACK_TABS } from './packs'
import { workspace } from '../lib/workspace.svelte'

export type Overlay = null | 'workspaces' | 'account' | 'settings'
export type SettingsPage = 'general' | 'projects' | 'cycles' | 'tabs' | 'members' | 'database' | 'connections' | 'models' | 'appearance'

export const ui = $state({
  tab: 'board' as string,
  /** The open doc, canvas or meeting inside the current tab, if any. */
  item: null as string | null,
  overlay: null as Overlay,
  settingsPage: 'general' as SettingsPage,
  settings: null as Settings | null,
  members: [] as Person[],
  me: null as Person | null,
  error: '',
  /** Which page of each pack tab is open, by tab type. */
  pack: Object.fromEntries(Object.entries(PACK_TABS).map(([type, p]) => [type, p.views[0]?.id ?? ''])) as Record<string, string>,
})

/** The page of a pack tab that is open: the last one picked, if the pack still has it. */
export function packView(type: string) {
  const views = PACK_TABS[type]?.views ?? []
  return views.some((v) => v.id === ui.pack[type]) ? ui.pack[type] : (views[0]?.id ?? '')
}

export function openPack(tabId: string, type: string, view: string) {
  ui.pack = { ...ui.pack, [type]: view }
  go(tabId)
  try {
    localStorage.setItem('alfredo.v2.pack', JSON.stringify(ui.pack))
  } catch {}
}
try {
  const saved = JSON.parse(localStorage.getItem('alfredo.v2.pack') ?? 'null')
  if (saved) ui.pack = { ...ui.pack, ...saved }
} catch {}

/** The workspace's tabs, straight from its settings in its own database. */
export function visibleTabs(): TabDef[] {
  if (!ui.settings) return []
  return (ui.settings.tabs ?? []).filter((t) => !t.hidden)
}

export function go(tab: string, item: string | null = null) {
  ui.tab = tab
  ui.item = item
  ui.overlay = null
  try {
    localStorage.setItem('alfredo.v2.tab', tab)
  } catch {}
}

/** Open one project, or all of them (null). Everything on screen follows. */
export function setProject(id: string | null) {
  scope.id = id
  rememberProject(workspace.activeId)
  ui.item = null
  ui.overlay = null
}

/** The workspace's projects, and which one was last open here. */
export async function loadProjects() {
  const w = workspace.activeId
  try {
    const r = await v2.get<{ enabled: boolean; projects: Project[]; canManage?: boolean; me?: string | null }>('/projects')
    scope.enabled = r.enabled
    scope.list = r.projects ?? []
    scope.canManage = !!r.canManage
    scope.meId = r.me ?? null
  } catch {
    scope.enabled = false
    scope.list = []
    scope.canManage = false
    scope.meId = null
  }
  recallProject(w)
}

export function openSettings(page: SettingsPage = 'general') {
  ui.settingsPage = page
  ui.overlay = 'settings'
}

export async function loadWorkspaceState(meEmail: string | null) {
  ui.error = ''
  ui.settings = null
  ui.members = []
  scope.enabled = false
  scope.list = []
  scope.id = null
  try {
    await loadProjects()
    const [s, m] = await Promise.all([v2.get<Settings>('/settings'), v2.get<Person[]>('/members')])
    ui.settings = s
    ui.members = m
    ui.me = (meEmail && m.find((p) => p.email?.toLowerCase() === meEmail.toLowerCase())) || m[0] || null
    const want = (() => {
      try {
        return localStorage.getItem('alfredo.v2.tab')
      } catch {
        return null
      }
    })()
    const tabs = visibleTabs()
    ui.tab = tabs.some((t) => t.id === want) ? want! : (tabs[0]?.id ?? 'board')
    ui.item = null
  } catch (e) {
    ui.error = (e as Error).message
  }
}
