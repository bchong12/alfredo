// Which project the app is looking at. Kept on its own so the API layer can
// scope every call without reaching into the rest of the UI state.
//
// null means "all projects": everything in the workspace, the way it is when
// a workspace does not use projects at all.
export type Project = {
  id: string
  name: string
  color: string
  archived?: boolean
  /** Everyone in the workspace, or only the people listed. Admins always get in. */
  access?: 'everyone' | 'members'
  members?: string[]
}

/** The colours a project can take. Same list the server accepts. */
export const PROJECT_COLORS_LIST = ['slate', 'blue', 'green', 'amber', 'rose', 'violet', 'teal', 'orange']

export const scope = $state({
  enabled: false,
  /** Only the projects this person can open. */
  list: [] as Project[],
  /** Whether this person may add projects and decide who is in them. */
  canManage: false,
  /** A project id, 'none' for work in no project, or null for all of it. */
  id: null as string | null,
})

export const NO_PROJECT = 'none'
export const activeProject = () => scope.list.find((p) => p.id === scope.id) ?? null
/** What the switcher says right now. */
export const projectLabel = () => (scope.id === NO_PROJECT ? 'No project' : (activeProject()?.name ?? 'All projects'))
export const liveProjects = () => scope.list.filter((p) => !p.archived)

const KEY = (ws: string) => `alfredo.v2.project.${ws}`

export function rememberProject(ws: string) {
  try {
    localStorage.setItem(KEY(ws), scope.id ?? 'all')
  } catch {}
}

export function recallProject(ws: string) {
  try {
    const want = localStorage.getItem(KEY(ws))
    const known = want === NO_PROJECT || scope.list.some((p) => p.id === want && !p.archived)
    scope.id = want && want !== 'all' && known ? want : null
  } catch {
    scope.id = null
  }
}

/** Every request carries the open project, so lists and new items match what is on screen. */
export const projectHeader = (): Record<string, string> => (scope.enabled && scope.id ? { 'x-project': scope.id } : {})
