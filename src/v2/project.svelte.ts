// Which project the app is looking at. Kept on its own so the API layer can
// scope every call without reaching into the rest of the UI state.
//
// null means "all projects": everything in the workspace, the way it is when
// a workspace does not use projects at all.
export type ProjectRole = 'admin' | 'write' | 'read'
export type ProjectMember = { personId: string; role: ProjectRole }
export type Project = {
  id: string
  name: string
  color: string
  archived?: boolean
  /** What you may do in it. Null never reaches the app: you only get yours. */
  role?: ProjectRole | null
  /** Who is in it. Only admins are told. */
  members?: ProjectMember[]
  /** Yours alone: made for you when you first opened a shared workspace. */
  personal?: boolean
}

/** The colours a project can take. Same list the server accepts. */
export const PROJECT_COLORS_LIST = ['slate', 'blue', 'green', 'amber', 'rose', 'violet', 'teal', 'orange']

export const scope = $state({
  enabled: false,
  /** Only the projects this person can open. */
  list: [] as Project[],
  /** Whether this person may add projects and decide who is in them. */
  canManage: false,
  /** Whether the shared room (work in no project) takes this person's edits. */
  canWrite: true,
  /** This person's id in the workspace, for reading the member lists. */
  meId: null as string | null,
  /** A project id, 'none' for work in no project, or null for all of it. */
  id: null as string | null,
})

/** General: the work that is in no project, the room everyone shares. */
export const NO_PROJECT = 'none'
/** Whether something in `project` belongs in the list on screen: everything
 *  does with no project open, only its own does inside one, and only the
 *  work in none under General. */
export const belongsHere = (project: string | null | undefined) =>
  !scope.enabled || !scope.id || (scope.id === NO_PROJECT ? !project : project === scope.id)

/**
 * A list after one of its items has been moved to `project`. The lists are
 * cut to a project by the server, so a doc moved out of the one on screen
 * used to sit there until the page was next loaded, which reads as "it did not
 * work". Moved out of view it leaves at once; and if the move is refused and
 * it is moved back, it returns, which is what `parked` is kept for.
 */
const parked = new Map<string, unknown>()
export function afterMove<T extends { id: string; project?: string | null }>(list: T[], id: string, project: string | null): T[] {
  const item = list.find((x) => x.id === id) ?? (parked.get(id) as T | undefined)
  if (!item) return list
  const moved = { ...item, project }
  parked.set(id, moved)
  if (!belongsHere(project)) return list.filter((x) => x.id !== id)
  return list.some((x) => x.id === id) ? list.map((x) => (x.id === id ? moved : x)) : [moved, ...list]
}

export const activeProject = () => scope.list.find((p) => p.id === scope.id) ?? null
/** What the switcher says right now. */
export const projectLabel = () => (scope.id === NO_PROJECT ? 'General' : (activeProject()?.name ?? 'Pick a project'))
/** What you may do where you are: a project's role, or the workspace's when nothing is open. */
export const myRole = (): ProjectRole => {
  if (!scope.enabled) return 'write'
  // Inside a project, its say; in the shared room, the workspace's.
  if (scope.id && scope.id !== NO_PROJECT) return activeProject()?.role ?? (scope.canManage ? 'admin' : 'read')
  return scope.canManage ? 'admin' : scope.canWrite ? 'write' : 'read'
}
export const canEditHere = () => myRole() !== 'read'
export const liveProjects = () => scope.list.filter((p) => !p.archived)
/** The team's projects: what an admin names, shares and edits. Not the personal ones. */
export const teamProjects = () => scope.list.filter((p) => !p.personal)
export const personalProject = () => scope.list.find((p) => p.personal) ?? null

const KEY = (ws: string) => `alfredo.v2.project.${ws}`

export function rememberProject(ws: string) {
  try {
    localStorage.setItem(KEY(ws), scope.id ?? 'all')
  } catch {}
}

export function recallProject(ws: string) {
  try {
    const want = localStorage.getItem(KEY(ws))
    const known = (want === NO_PROJECT && scope.canManage) || scope.list.some((p) => p.id === want && !p.archived)
    // With projects on there is no view across all of them: open one.
    scope.id = want && known ? want : (liveProjects()[0]?.id ?? (scope.canManage ? NO_PROJECT : null))
  } catch {
    scope.id = null
  }
}

/** Every request carries the open project, so lists and new items match what is on screen. */
export const projectHeader = (): Record<string, string> => (scope.enabled && scope.id ? { 'x-project': scope.id } : {})

/**
 * Check the open project against the workspace, and let it go if it is not
 * there any more. A call that was refused over a project runs again after.
 */
export async function forgetProject(): Promise<void> {
  const { refreshProjects } = await import('./state.svelte')
  await refreshProjects()
}
