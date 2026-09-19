// The Alfredo MCP server: the same workspaces the app shows (board, docs,
// canvases, meetings), whatever database each one lives in, plus the tools
// that connect new databases.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { storeFor, mondayOf, tabsProblem, PACK_KEY, STATUSES as V2_STATUSES } from './v2'
import * as wsReg from './workspaces'
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

- Read and write: ws_list, ws_read, ws_write (cards, docs, canvases, meetings, members).
- Shape the workspace: get_workspace, set_workspace_tabs (the tabs JSON), pack data tools.
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

  const ws = () => storeFor(current())

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

  add(
    'ws_list',
    'List cards, docs, canvases, meetings or members in this workspace.',
    { kind: z.enum(['cards', 'docs', 'canvases', 'meetings', 'members']) },
    async ({ kind }) => {
      const s = ws()
      const r = kind === 'cards' ? await s.cardsIn([mondayOf()]) : kind === 'docs' ? await s.docs() : kind === 'canvases' ? await s.canvases() : kind === 'meetings' ? await s.meetings() : await s.members()
      return ok(r)
    },
  )

  add(
    'ws_read',
    'Read one doc (Markdown), canvas (nodes and edges), or meeting (notes and transcript) by id.',
    { kind: z.enum(['doc', 'canvas', 'meeting']), id: z.string() },
    async ({ kind, id }) => {
      const s = ws()
      return ok(kind === 'doc' ? await s.doc(id) : kind === 'canvas' ? await s.canvas(id) : await s.meeting(id))
    },
  )

  add(
    'ws_write',
    'Create or update a card or doc. Without id it creates. Cards take title, body, status (todo|progress|review|done); docs take title and Markdown body.',
    {
      kind: z.enum(['card', 'doc']),
      id: z.string().optional(),
      title: z.string().optional(),
      body: z.string().optional(),
      status: z.enum(V2_STATUSES as [string, ...string[]]).optional(),
    },
    async ({ kind, id, title, body, status }) => {
      const s = ws()
      if (kind === 'card') {
        if (!id) {
          const c = await s.createCard({ title: title ?? 'Untitled', status: status as any })
          return ok(body ? await s.updateCard(c.id, { body }) : c)
        }
        return ok(await s.updateCard(id, { title, body, status: status as any }))
      }
      if (!id) return ok(await s.createDoc(title ?? 'Untitled', body ?? ''))
      const cur = await s.doc(id)
      return ok(await s.saveDoc(id, { title: title ?? cur.title, body: body ?? cur.body, revision: cur.revision }))
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
