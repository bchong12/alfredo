// The one door between the workspace API and the machine it happens to run on.
//
// v2.ts has to run in two places: inside the desktop app, where there is a
// disk, a microphone, local models and a shell; and as the hosted site's API,
// where there is none of that. Rather than sprinkle "if desktop" through it,
// everything that needs a machine is asked of whatever is behind this door.
// The desktop app puts v2-desktop.ts there at startup. The hosted site leaves
// it as it is: nothing to remember between requests, nothing read in, no
// recorder, and no routes added.
import type { Hono } from 'hono'
import type { Shelf } from './chunk-shelf'
import type { ItemKind, Store } from './v2'
import type { Workspace } from './workspaces'

export type MachineRoutes = {
  store: () => Store
  current: () => { workspace: Workspace; db: unknown } | undefined
  mine: (c: any) => Promise<{ me: { id: string | null; admin: boolean }; all: any[]; allowed: any[] }>
  projectOf: (c: any) => string | null
  mapOf: (st: Store) => Promise<Record<string, string>>
  NO_PROJECT: string
}

export type Machine = {
  /** Passages kept on this machine, for a database with nowhere to keep them. */
  shelfFor(workspace: string): Shelf
  /** Something was saved: read it in, behind the screen. */
  touch(store: Store, kind: ItemKind, id: string, workspace: string): void
  /** Something is gone: a question should no longer find it. */
  forget(store: Store, kind: ItemKind, id: string): Promise<void>
  /** The workspace is in use: look for anything not read in yet. */
  keepReadIn(store: Store, workspace: string): void
  /** Where a Supabase workspace's invite link should point, when this machine keeps that. */
  inviteKeys(workspace: string): { url: string; anonKey: string } | null
  thumbs: { read(): Record<string, string | null>; write(all: Record<string, string | null>): void }
  /** Routes only a machine can serve: the brain, recording, the calendar. */
  routes(app: Hono, ctx: MachineRoutes): void
}

const nowhere = (): never => {
  throw new Error('That needs the Alfredo desktop app: there is nowhere here to keep it.')
}

/** No machine at all: what the hosted site runs with. */
export const NO_MACHINE: Machine = {
  shelfFor: nowhere,
  touch: () => {},
  forget: async () => {},
  keepReadIn: () => {},
  inviteKeys: () => null,
  thumbs: { read: () => ({}), write: () => {} },
  routes: () => {},
}

let machine: Machine = NO_MACHINE
export const useMachine = (m: Machine) => void (machine = m)
export const theMachine = () => machine
