// The Alfredo MCP server: the same workspaces the app shows (board, docs,
// canvases, meetings), whatever database each one lives in, plus the tools
// that connect new databases.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { storeFor, mondayOf, tabsProblem, PACK_KEY, PROJECT_COLORS, STATUSES as V2_STATUSES } from './v2'
import { randomUUID } from 'node:crypto'
import * as wsReg from './workspaces'
import { inviteLink } from './invite-link'
import { ask, findPassages, indexProgress, keepReadIn, reindex, touch } from './knowledge'
import { embedderState } from './embed'
import * as connect from './connect'
import * as cfDeploy from './cloudflare-deploy'
import { schemaSql } from './supabase-connect'

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

const ok = (v: unknown): ToolResult => ({
  content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }],
})

const fail = (e: unknown): ToolResult => ({
  content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
  isError: true,
})

export function createMcpServer(current: () => { workspace: any; db: unknown } | undefined = () => undefined) {
  const server = new McpServer(
    { name: 'alfredo', version: '0.2.0' },
    {
      instructions: `Alfredo: a team's board, docs, canvases and meetings, each workspace in
its own database (a folder on this Mac, a Supabase project, or a Cloudflare D1).
Every call lands on one workspace, chosen by the x-workspace header this
connection was opened with; list_workspaces shows them all.

- Ask it things: ask_workspace answers from everything this workspace has
  written down, with citations; search_workspace hands back the passages. Ask
  before answering anything about how this team works or what was decided.
- Read and write: ws_list, ws_read, ws_write (cards, docs, canvases, meetings, members).
- Shape the workspace: get_workspace, set_workspace_tabs (the tabs JSON), pack data tools.
- Projects (optional, per workspace): list_projects, create_project, move_to_project,
  set_projects_enabled. ws_list and ws_write take a project by name.
- Connect databases: connect_supabase (an access token is easiest), connect_cloudflare,
  create_cloudflare_workspace (uses the user's wrangler login).

Show the user what you are about to change before changing tabs, pack data or
connecting a database, and never repeat back tokens or keys.`,
    },
  )

  const add = (
    name: string,
    description: string,
    shape: z.ZodRawShape,
    handler: (args: any) => Promise<ToolResult>,
  ) => {
    server.registerTool(name, { description, inputSchema: shape }, async (args: any) => {
      try {
        return await handler(args ?? {})
      } catch (e) {
        return fail(e)
      }
    })
  }

  // ------------------------------------------------------------- any workspace
  // These five work whatever the workspace lives in (a folder, Supabase or a
  // Cloudflare D1 behind its Worker). The tools further down predate that and
  // only work on folder and Supabase workspaces.

  /* An agent at work is the workspace in use, the same as the app open: it
     wakes the look for anything not read in yet. */
  const ws = () => {
    const store = storeFor(current())
    keepReadIn(store, current()?.workspace.id ?? '')
    return store
  }
  const currentWorkspaceId = () => current()?.workspace.id ?? ''

  add(
    'get_workspace',
    "This workspace's settings: its name and its tabs JSON (id, type, name, hidden, columns). Types: board, docs, canvas, meetings, or a pack's type (e.g. marketing).",
    {},
    async () => ok(await ws().settings()),
  )

  add(
    'set_workspace_tabs',
    'Replace the tabs JSON. Show the user the new list before calling. Every tab needs id, name and type (board, docs, canvas, meetings, or a pack type such as marketing or management); set hidden: true to hide one.',
    {
      tabs: z
        .array(
          z.object({
            id: z.string(),
            type: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
            name: z.string(),
            hidden: z.boolean().optional(),
            columns: z.array(z.string()).optional(),
          }),
        )
        .min(1),
    },
    async ({ tabs }) => {
      const problem = tabsProblem(tabs)
      return problem ? fail(new Error(problem)) : ok(await ws().saveSettings({ tabs }))
    },
  )

  // ------------------------------------------------------------- the brain
  // Everything the workspace has written down, in a form a question reaches.
  // The search runs as this connection's workspace and person, so it can only
  // find what they could open themselves.

  add(
    'ask_workspace',
    "Answer a question from this workspace's own docs, meetings, cards and canvases. Use it before answering anything about how this team works, what was decided, or who owns what: the workspace is the source, not your own memory. Comes back with the answer and what it was taken from.",
    { question: z.string().min(3), depth: z.number().optional().describe('How many passages to weigh, 4 to 30. Default 14.') },
    async ({ question, depth }) => ok(await ask(ws(), question, Math.min(Math.max(Number(depth) || 14, 4), 30))),
  )

  add(
    'search_workspace',
    'The passages behind an answer, without writing one: the best matching pieces of docs, meetings, cards and canvases, each with where it came from. Use it when you want the raw material rather than a summary.',
    { query: z.string().min(2), limit: z.number().optional() },
    async ({ query, limit }) => ok(await findPassages(ws(), query, Math.min(Math.max(Number(limit) || 10, 1), 30))),
  )

  add(
    'read_workspace_in',
    'Read the whole workspace in, so questions can reach it. Needed once per workspace, and again only if something was written outside Alfredo. Returns at once; call brain_status to watch it.',
    {},
    async () => ok(reindex(ws(), currentWorkspaceId())),
  )

  add(
    'brain_status',
    'Whether this workspace has been read in: the model, how many passages are stored, and how a reading is going.',
    {},
    async () => {
      const chunks = await ws().chunkCount().catch(() => 0)
      return ok({ ...embedderState(), chunks, progress: indexProgress(currentWorkspaceId()) })
    },
  )

  add(
    'list_pack_data',
    "List the pack data this workspace keeps in its own database (a pack is an add-on tab like Marketing; its data is keyed like 'marketing.inspiration').",
    {},
    async () => ok(await ws().packKeys()),
  )

  add(
    'get_pack_data',
    "Read one pack data entry by key, e.g. 'marketing.slideshows'. Large libraries come back whole, so prefer list_pack_data first.",
    { key: z.string().regex(PACK_KEY) },
    async ({ key }) => {
      const p = await ws().pack(key)
      return p ? ok(p.value) : fail(new Error(`No "${key}" data in this workspace.`))
    },
  )

  add(
    'set_pack_data',
    "Replace one pack data entry (JSON). Show the user what changes before calling; the apps read it straight from this workspace's database.",
    { key: z.string().regex(PACK_KEY), value: z.any() },
    async ({ key, value }) => {
      await ws().setPack(key, value)
      return ok({ ok: true, key })
    },
  )

  const KIND_OF = { cards: 'card', docs: 'doc', canvases: 'canvas', meetings: 'meeting' } as const
  /** Project ids by name or id, so Claude can say "Launch" instead of a uuid. */
  const projectId = async (p?: string) => {
    if (!p) return null
    const list = await ws().projects()
    const hit = list.find((x) => x.id === p || x.name.toLowerCase() === p.toLowerCase())
    if (!hit) throw new Error(`No project "${p}". list_projects shows them.`)
    return hit.id
  }

  add(
    'ws_list',
    "List cards, docs, canvases, meetings or members in this workspace. Cards are this cycle's unless week says otherwise: a Monday (2026-09-21), 'backlog', or 'all' for every card there is. With project (name or id), only that project's items; each item says which project it is in.",
    {
      kind: z.enum(['cards', 'docs', 'canvases', 'meetings', 'members', 'card', 'doc', 'canvas', 'meeting', 'member']),
      project: z.string().optional(),
      week: z.string().optional(),
    },
    async ({ kind: given, project, week }: { kind: string; project?: string; week?: string }) => {
      const s = ws()
      // Singular or plural: nobody should have to remember which.
      const kind = (given.endsWith('s') ? given : `${given}s`) as 'cards' | 'docs' | 'canvases' | 'meetings' | 'members'
      if (kind === 'members') return ok(await s.members())
      const when = (week ?? '').trim().toLowerCase()
      const cards = async () => {
        if (when === 'backlog') return await s.cardsIn('backlog')
        if (when !== 'all') return await s.cardsIn([when || mondayOf()])
        // Every card there is: an empty week list means no weeks, not all of
        // them, so the weeks are asked for first.
        const weeks = [...(await s.tally()).weeks.keys()]
        const [inCycles, waiting] = await Promise.all([weeks.length ? s.cardsIn(weeks) : [], s.cardsIn('backlog')])
        return [...inCycles, ...waiting]
      }
      const r: any[] = kind === 'cards' ? await cards() : kind === 'docs' ? await s.docs() : kind === 'canvases' ? await s.canvases() : await s.meetings()
      const pid = await projectId(project)
      const map = await s.projectMap().catch(() => ({}) as Record<string, string>)
      const k = KIND_OF[kind]
      return ok(r.filter((x) => !pid || map[`${k}:${x.id}`] === pid).map((x) => ({ ...x, project: map[`${k}:${x.id}`] ?? null })))
    },
  )

  add(
    'list_projects',
    'The projects this workspace is split into (when projects are on): id, name, colour, and who can open each one.',
    {},
    async () => {
      const s = ws()
      const [set, list] = await Promise.all([s.settings(), s.projects()])
      // Personal projects are one person's own; a connection with no person
      // behind it is handed none of them.
      const personal = new Set(Object.values(set.personal ?? {}))
      return ok({ enabled: !!set.projects?.enabled, projects: list.filter((p) => !personal.has(p.id)) })
    },
  )

  add(
    'create_project',
    'Add a project and turn projects on if they were off. Colours: slate, blue, green, amber, rose, violet, teal, orange. Only the people you list are in it (workspace admins always are); each takes a role: admin, write or read.',
    {
      name: z.string().min(1),
      color: z.string().optional(),
      people: z.array(z.object({ person: z.string(), role: z.enum(['admin', 'write', 'read']).optional() })).optional(),
    },
    async ({ name, color, people }) => {
      const s = ws()
      const list = await s.projects()
      const rows = await s.members()
      const members = (people ?? []).map((x: { person: string; role?: string }) => {
        const hit = rows.find((m) => m.id === x.person || m.name.toLowerCase() === x.person.toLowerCase() || m.email?.toLowerCase() === x.person.toLowerCase())
        if (!hit) throw new Error(`Nobody here called "${x.person}". ws_list members shows them.`)
        return { personId: hit.id, role: (x.role ?? 'write') as 'admin' | 'write' | 'read' }
      })
      const p = { id: randomUUID(), name: name.trim().slice(0, 60), color: PROJECT_COLORS.includes(color ?? '') ? color! : 'slate', members }
      await s.saveProjects([...list, p])
      await s.saveSettings({ projects: { enabled: true } })
      return ok(p)
    },
  )

  add(
    'set_project_people',
    "Say who is in a project and what they may do there: admin, write or read. Replaces the list, so pass everyone who should be in it. Workspace admins are in every project anyway.",
    {
      project: z.string(),
      people: z.array(z.object({ person: z.string(), role: z.enum(['admin', 'write', 'read']).optional() })),
    },
    async ({ project, people }) => {
      const s = ws()
      const list = await s.projects()
      const id = await projectId(project)
      const rows = await s.members()
      const members = people.map((x: { person: string; role?: string }) => {
        const hit = rows.find((m) => m.id === x.person || m.name.toLowerCase() === x.person.toLowerCase() || m.email?.toLowerCase() === x.person.toLowerCase())
        if (!hit) throw new Error(`Nobody here called "${x.person}".`)
        return { personId: hit.id, role: (x.role ?? 'write') as 'admin' | 'write' | 'read' }
      })
      await s.saveProjects(list.map((p) => (p.id === id ? { ...p, members } : p)))
      return ok((await s.projects()).find((p) => p.id === id))
    },
  )

  add(
    'invite_person',
    "Invite someone to the workspace and hand back a link to send them. They open Alfredo, paste it, sign in with that email, and land in the projects you name. Show the user the link; do not send it anywhere yourself.",
    {
      email: z.string(),
      role: z.enum(['admin', 'member']).optional(),
      projects: z.array(z.object({ project: z.string(), role: z.enum(['admin', 'write', 'read']).optional() })).optional(),
    },
    async ({ email, role, projects }) => {
      const s = ws()
      const wanted = []
      for (const p of projects ?? []) wanted.push({ id: (await projectId(p.project))!, role: (p.role ?? 'write') as 'admin' | 'write' | 'read' })
      const { invite, token } = await s.createInvite({ email: email.trim().toLowerCase(), role: role === 'admin' ? 'admin' : 'member', projects: wanted })
      const w = current()?.workspace ?? null
      const k = w?.kind === 'remote' ? wsReg.supabaseFor(w.id) : null
      const link = k
        ? inviteLink({ kind: 'supabase', url: k.url, anonKey: k.anonKey, name: w!.name, token })
        : w?.kind === 'cloudflare' && w.cloudflare?.url
          ? inviteLink({ kind: 'cloudflare', url: w.cloudflare.url, name: w.name, token })
          : null
      return ok({ invite, link })
    },
  )

  add(
    'set_projects_enabled',
    'Turn projects on or off for this workspace. Off keeps every project and assignment; the app just shows everything together.',
    { enabled: z.boolean() },
    async ({ enabled }) => ok(await ws().saveSettings({ projects: { enabled } })),
  )

  add(
    'move_to_project',
    'Put cards, docs, canvases or meetings into a project (name or id), or pass project null to take them out of any.',
    { kind: z.enum(['card', 'doc', 'canvas', 'meeting']), ids: z.array(z.string()).min(1), project: z.string().nullable() },
    async ({ kind, ids, project }) => {
      await ws().assign(kind, ids, await projectId(project ?? undefined))
      return ok({ ok: true, moved: ids.length })
    },
  )

  add(
    'ws_read',
    'Read one doc (Markdown), canvas (nodes and edges), meeting (notes and transcript) or card by id. Singular or plural, either is fine.',
    { kind: z.enum(['doc', 'canvas', 'meeting', 'card', 'docs', 'canvases', 'meetings', 'cards']), id: z.string() },
    async ({ kind: given, id }: { kind: string; id: string }) => {
      const s = ws()
      const kind = given.replace(/s$|es$/, '').replace('canvase', 'canvas')
      if (kind === 'doc') return ok(await s.doc(id))
      if (kind === 'canva' || kind === 'canvas') return ok(await s.canvas(id))
      if (kind === 'meeting') return ok(await s.meeting(id))
      // A card is only ever found in a list, so this looks through the ones
      // there are rather than asking for it by name.
      const all = [...(await s.cardsIn([]).catch(() => [])), ...(await s.cardsIn('backlog').catch(() => []))]
      const card = all.find((c: any) => c.id === id || c.ref === id)
      if (!card) throw new Error(`No card ${id} in this workspace.`)
      return ok(card)
    },
  )

  add(
    'ws_write',
    'Create or update a card or doc. Without id it creates. Cards take title, body, status (todo|progress|review|done); docs take title and Markdown body.',
    {
      kind: z.enum(['card', 'doc']),
      id: z.string().optional(),
      project: z.string().optional().describe('For new items: the project (name or id) to put it in.'),
      title: z.string().optional(),
      body: z.string().optional(),
      status: z.enum(V2_STATUSES as [string, ...string[]]).optional(),
    },
    async ({ kind, id, title, body, status, project }) => {
      const s = ws()
      const pid = id ? null : await projectId(project)
      /* What an agent writes is read in like anything written in the app, so
         the next question can find it. */
      const learn = <T extends { id: string }>(made: T) => (touch(s, kind, made.id, current()?.workspace.id ?? ''), made)
      if (kind === 'card') {
        if (!id) {
          const c = await s.createCard({ title: title ?? 'Untitled', status: status as any })
          if (pid) await s.assign('card', [c.id], pid)
          return ok(learn(body ? await s.updateCard(c.id, { body }) : c))
        }
        return ok(learn(await s.updateCard(id, { title, body, status: status as any })))
      }
      if (!id) {
        const d = await s.createDoc(title ?? 'Untitled', body ?? '')
        if (pid) await s.assign('doc', [d.id], pid)
        return ok(learn(d))
      }
      const cur = await s.doc(id)
      return ok(learn(await s.saveDoc(id, { title: title ?? cur.title, body: body ?? cur.body, revision: cur.revision })))
    },
  )

  // ------------------------------------------------------------- databases
  // Connecting a workspace to a database you own. These act on the registry,
  // not on the current workspace. Tokens and keys go to the macOS keychain;
  // never echo them back to the user.

  add(
    'list_workspaces',
    'Every workspace on this Mac: id, name, and where its data lives (local folder, Supabase project, or Cloudflare Worker). Name one in the x-workspace header to work in it.',
    {},
    async () =>
      ok(
        wsReg.list().map((w) => ({
          id: w.id,
          name: w.name,
          kind: w.kind === 'remote' ? 'supabase' : w.kind,
          where: w.kind === 'cloudflare' ? w.cloudflare?.url : w.kind === 'remote' ? (wsReg.supabaseFor(w.id)?.url ?? 'keys missing') : 'this Mac',
          active: wsReg.active()?.id === w.id,
        })),
      ),
  )

  const supaToken = (t?: string) => t?.trim() || process.env.SUPABASE_ACCESS_TOKEN || ''

  add(
    'list_supabase_projects',
    'List the Supabase projects a personal access token can see (from supabase.com/dashboard/account/tokens). Omit the token to use SUPABASE_ACCESS_TOKEN from the environment.',
    { accessToken: z.string().optional() },
    async ({ accessToken }) => {
      const t = supaToken(accessToken)
      if (!t) return fail(new Error('Ask the user for a Supabase personal access token (supabase.com/dashboard/account/tokens).'))
      return ok(await connect.supabaseProjects(t))
    },
  )

  add(
    'connect_supabase',
    'Add a workspace backed by a Supabase project. Easiest: accessToken + projectRef, and Alfredo fetches the keys and creates the tables itself. Or url + anonKey + serviceKey, and if tables are missing the result carries the SQL for the user to run once in the SQL editor. Confirm the workspace name with the user first.',
    {
      name: z.string(),
      accessToken: z.string().optional(),
      projectRef: z.string().optional(),
      url: z.string().optional(),
      anonKey: z.string().optional(),
      serviceKey: z.string().optional(),
    },
    async ({ name, accessToken, projectRef, url, anonKey, serviceKey }) => {
      const token = anonKey || serviceKey ? accessToken : supaToken(accessToken)
      try {
        const r = await connect.connectSupabase({ name, accessToken: token || undefined, ref: projectRef, url, anonKey, serviceKey })
        return ok({ ...r, sql: r.sql ? '(use get_setup_sql to show it)' : undefined })
      } catch (e) {
        if (e instanceof connect.NeedsProject) return ok({ needsProject: true, projects: e.projects })
        return fail(e)
      }
    },
  )

  add(
    'get_setup_sql',
    "The SQL that creates Alfredo's tables in a Supabase project (idempotent). For the user to paste into the SQL editor when no access token is available.",
    {},
    async () => ok(schemaSql()),
  )

  add(
    'setup_supabase_tables',
    "Check a Supabase workspace's tables, and with an access token create any that are missing (also how you upgrade after an Alfredo update).",
    { workspaceId: z.string(), accessToken: z.string().optional() },
    async ({ workspaceId, accessToken }) => ok(await connect.setupSupabaseSchema(workspaceId, supaToken(accessToken) || undefined)),
  )

  add(
    'connect_cloudflare',
    'Add a workspace backed by an existing Alfredo Worker on Cloudflare: its https URL and its workspace API token.',
    { name: z.string(), url: z.string(), token: z.string() },
    async ({ name, url, token }) => ok(await connect.connectCloudflare({ name, url, token })),
  )

  add(
    'create_cloudflare_workspace',
    "Create a brand-new workspace database in the user's own Cloudflare account (D1 + a small Worker), using their wrangler login, and connect it. Takes about a minute; returns a job id to pass to get_cloudflare_deploy. Confirm with the user first: it creates resources in their account.",
    { name: z.string() },
    async ({ name }) => {
      const who = await cfDeploy.cloudflareLogin()
      if (!who.loggedIn) return fail(new Error('Wrangler is not logged in. Ask the user to run `npx wrangler login` in a terminal, then try again.'))
      const job = cfDeploy.startDeploy(name, (url, token) => connect.connectCloudflare({ name, url, token }))
      return ok({ job, account: who.email, worker: cfDeploy.workerName(name) })
    },
  )

  add(
    'get_cloudflare_deploy',
    'Progress of create_cloudflare_workspace: step (check, database, tables, worker, token, connect, done, failed), log, and error.',
    { job: z.string() },
    async ({ job }) => {
      const j = cfDeploy.deployJob(job)
      return j ? ok(j) : fail(new Error('No such deploy job.'))
    },
  )

  return server
}
