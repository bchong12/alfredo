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
  /** The open project, or null for all of them. */
  id: null as string | null,
})

export const activeProject = () => scope.list.find((p) => p.id === scope.id) ?? null
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
    scope.id = want && want !== 'all' && scope.list.some((p) => p.id === want && !p.archived) ? want : null
  } catch {
    scope.id = null
  }
}

/** Every request carries the open project, so lists and new items match what is on screen. */
export const projectHeader = (): Record<string, string> => (scope.enabled && scope.id ? { 'x-project': scope.id } : {})
