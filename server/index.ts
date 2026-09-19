// Alfredo's local server: the MCP endpoint and the REST API for the app,
// against whichever workspace each request names. Bound to loopback: it
// holds database keys, so nothing off this Mac may reach it.

import { Hono } from 'hono'
import { AsyncLocalStorage } from 'node:async_hooks'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { StreamableHTTPTransport } from '@hono/mcp'
import { randomUUID } from 'node:crypto'
import { createMcpServer } from './mcp'
import { remoteDb, setDbResolver } from './db'
import { LOCAL_USER } from './local-user'
import * as ws from './workspaces'
import * as composio from './composio'
import { parakeetAvailable } from './parakeet'
import { claudeAvailable, claudeChat } from './claude-local'
import { setLocalChat } from './ai'
import * as audio from './audio'
import { requireSession } from './auth'
import { prefixFor, setRefPrefix } from '../src/lib/ref'
import { v2Routes } from './v2'
import * as connect from './connect'
import * as cfDeploy from './cloudflare-deploy'

const PORT = Number(process.env.CRM_PORT ?? 29981)
const MCP_PATH = '/mcp'
const ALLOWED_HOSTS = [`127.0.0.1:${PORT}`, `localhost:${PORT}`]

/**
 * The public build does NOT carry the MCP endpoint.
 *
 * MCP has no authentication of its own; on the Mac it is protected purely by
 * being on loopback. Publishing it would put an unauthenticated read/write API
 * to every transcript, card and doc on the internet. Nothing is lost by
 * leaving it out: the data lives in Supabase, so Claude reaches all of it
 * through the local server anyway.
 */
const PUBLIC = process.env.CRM_PUBLIC === '1'

const app = new Hono()

/*
 * Which workspace a request is talking to travels in AsyncLocalStorage, so
 * `db` resolves correctly everywhere down the call stack -- routes, the MCP
 * tools, and the detached transcription work a request starts and does not
 * wait for. Requests name a workspace with the x-workspace header; anything
 * that does not gets the active one.
 */
type Ctx = { db: unknown; workspace: ws.Workspace }
const ctx = new AsyncLocalStorage<Ctx>()
setDbResolver(() => ctx.getStore()?.db ?? remoteDb())
setRefPrefix(() => {
  const w = ctx.getStore()?.workspace
  return w ? (w.prefix ?? prefixFor(w.name)) : 'PUR'
})

async function contextFor(id?: string | null): Promise<Ctx | null> {
  const w = (id && ws.get(id)) || ws.active()
  if (!w) return null
  return { db: await ws.dbFor(w.id), workspace: w }
}

if (!PUBLIC) ws.ensureDefaults()

// Write-ups through Claude Code on this Mac when it is installed.
if (!PUBLIC && process.env.ALFRED_LOCAL_BRAIN !== '0') {
  claudeAvailable().then((ok) => {
    if (ok) {
      setLocalChat(claudeChat)
      console.log('write-ups: claude code (local)')
    } else console.log('write-ups: hosted model (claude not found on PATH)')
  })
}

if (!PUBLIC) {
  audio.prepare()
  console.log(`recording: ${audio.nativeAvailable() ? 'system audio + mic (alfredo-audio)' : 'microphone via ffmpeg (build native/alfredo-audio for system audio)'}`)
}

// Transcription runs on this Mac once Parakeet is downloaded (Meetings offers it).
if (!PUBLIC) console.log(`transcription: ${parakeetAvailable() ? 'parakeet (local)' : 'parakeet not downloaded yet'}`)

// Block browsers (Origin) and DNS-rebinding (bad Host) from reaching MCP.
app.use(MCP_PATH, async (c, next) => {
  if (PUBLIC) return c.json({ error: 'not available' }, 404)
  if (c.req.method === 'OPTIONS') return c.text('forbidden', 403)
  if (c.req.header('origin')) return c.json({ error: 'forbidden' }, 403)
  const host = c.req.header('host')
  if (host && !ALLOWED_HOSTS.includes(host)) {
    return c.json({ error: 'forbidden: invalid host' }, 403)
  }
  await next()
})

const sessions = new Map<
  string,
  { server: ReturnType<typeof createMcpServer>; transport: StreamableHTTPTransport }
>()

app.all(MCP_PATH, async (c) => {
  if (PUBLIC) return c.json({ error: 'not available' }, 404)
  const id = c.req.header('mcp-session-id') ?? randomUUID()
  let s = sessions.get(id)
  if (!s) {
    const server = createMcpServer(() => ctx.getStore() as any)
    const transport = new StreamableHTTPTransport()
    await server.connect(transport)
    s = { server, transport }
    sessions.set(id, s)
  }
  const store = await contextFor(c.req.header('x-workspace'))
  if (!store) return c.json({ error: 'no workspace' }, 500)
  return ctx.run(store, () => s!.transport.handleRequest(c))
})

// --- REST for the UI (same origin as the Vite dev server via proxy) ---------
app.use('/api/*', cors({ origin: ['http://localhost:5210', 'http://127.0.0.1:5210'] }))

app.use('/api/*', async (c, next) => {
  if (PUBLIC) return requireSession(c, next)
  // The registry sits outside every workspace and needs no session: it is what
  // the UI reads before it knows which workspace to name.
  if (c.req.path.startsWith('/api/workspaces')) return next()
  const store = await contextFor(c.req.header('x-workspace') ?? c.req.query('ws'))
  if (!store) return c.json({ error: 'no workspace' }, 400)
  return ctx.run(store, async () => {
    // Sessions and the microphone belong to this Mac, not to a workspace, so
    // they are open to whoever is at the keyboard regardless of sign-in.
    if (store.workspace.kind === 'local' || store.workspace.kind === 'cloudflare' || c.req.path.startsWith('/api/local/') || c.req.path.startsWith('/api/composio/')) {
      ;(c as any).set('person', LOCAL_USER)
      return next()
    }
    // Each remote workspace checks sessions against its own Supabase project.
    const project = ws.supabaseFor(store.workspace.id)
    if (!project) return c.json({ error: 'This workspace has lost its Supabase keys. Reconnect it in Settings > Database.' }, 503)
    return requireSession(c, next, project.url === process.env.SUPABASE_URL ? undefined : project)
  })
})

/* --- workspaces -------------------------------------------------------------
 * The registry itself is not inside any workspace, so these never touch `db`.
 */
app.get('/api/workspaces', (c) =>
  c.json({ active: ws.active()?.id ?? null, workspaces: ws.list().map(ws.publicView) }),
)
app.post('/api/workspaces', async (c) => {
  const b = await c.req.json<{ name?: string; repos?: string[] }>()
  if (!b.name?.trim()) return c.json({ error: 'name required' }, 400)
  return c.json(ws.publicView(ws.create({ name: b.name, repos: b.repos })))
})
app.patch('/api/workspaces/:id', async (c) => {
  const b = await c.req.json<{
    name?: string
    repos?: string[]
    prefix?: string
    canvas?: { baseUrl: string; token: string } | null
    composio?: Record<string, string>
    automations?: ws.Automation[]
  }>()
  // A blank token means "keep the one you have": the browser never sees it.
  if (b.canvas && !b.canvas.token) {
    const have = ws.get(c.req.param('id'))?.canvas
    b.canvas = have ? { baseUrl: b.canvas.baseUrl || have.baseUrl, token: have.token } : null
  }
  const w = ws.update(c.req.param('id'), b)
  return w ? c.json(ws.publicView(w)) : c.json({ error: 'no such workspace' }, 404)
})
/* Connect a workspace that lives in Cloudflare (D1 behind its Worker). The
 * token goes to the keychain; the registry only records the URL. */
app.post('/api/workspaces/cloudflare', async (c) => {
  if (PUBLIC) return c.json({ error: 'not available' }, 404)
  const b = await c.req.json<{ name?: string; url?: string; token?: string }>()
  try {
    return c.json(await connect.connectCloudflare({ name: b.name ?? '', url: b.url ?? '', token: b.token ?? '' }))
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400)
  }
})
/* Create a new workspace database in your own Cloudflare account, with your
 * wrangler login. Starts a job; the UI polls it. */
app.get('/api/workspaces/cloudflare/login', async (c) => {
  if (PUBLIC) return c.json({ error: 'not available' }, 404)
  return c.json(await cfDeploy.cloudflareLogin())
})
app.post('/api/workspaces/cloudflare/deploy', async (c) => {
  if (PUBLIC) return c.json({ error: 'not available' }, 404)
  const b = await c.req.json<{ name?: string }>()
  const name = b.name?.trim()
  if (!name) return c.json({ error: 'Name the workspace first.' }, 400)
  const job = cfDeploy.startDeploy(name, (url, token) => connect.connectCloudflare({ name, url, token }))
  return c.json({ job })
})
app.get('/api/workspaces/cloudflare/deploy/:job', (c) => {
  const j = cfDeploy.deployJob(c.req.param('job'))
  if (!j) return c.json({ error: 'no such job' }, 404)
  const w = j.step === 'done' ? ws.list().find((x) => x.cloudflare?.url === j.url) : null
  return c.json({ ...j, workspaceId: w?.id ?? null })
})
/* Connect a workspace to its own Supabase project: with an access token
 * (Alfredo fetches the keys and creates the tables) or with the URL and keys
 * (Alfredo returns the SQL to run once if the tables are missing). */
app.post('/api/workspaces/supabase/projects', async (c) => {
  if (PUBLIC) return c.json({ error: 'not available' }, 404)
  const b = await c.req.json<{ accessToken?: string }>()
  if (!b.accessToken?.trim()) return c.json({ error: 'Paste a Supabase access token.' }, 400)
  try {
    return c.json(await connect.supabaseProjects(b.accessToken))
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400)
  }
})
app.post('/api/workspaces/supabase', async (c) => {
  if (PUBLIC) return c.json({ error: 'not available' }, 404)
  const b = await c.req.json<connect.SupabaseConnect>()
  try {
    return c.json(await connect.connectSupabase(b))
  } catch (e) {
    if (e instanceof connect.NeedsProject) return c.json({ error: e.message, projects: e.projects }, 409)
    return c.json({ error: (e as Error).message }, 400)
  }
})
app.post('/api/workspaces/:id/account', async (c) => {
  if (PUBLIC) return c.json({ error: 'not available' }, 404)
  const b = await c.req.json<{ email?: string; password?: string; name?: string }>()
  try {
    return c.json(await connect.createAccount(c.req.param('id'), { email: b.email ?? '', password: b.password ?? '', name: b.name }))
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400)
  }
})
app.post('/api/workspaces/:id/schema', async (c) => {
  if (PUBLIC) return c.json({ error: 'not available' }, 404)
  const b = await c.req.json<{ accessToken?: string }>().catch(() => ({}) as { accessToken?: string })
  try {
    return c.json(await connect.setupSupabaseSchema(c.req.param('id'), b.accessToken))
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400)
  }
})
app.get('/api/workspaces/:id/status', async (c) => {
  const w = ws.get(c.req.param('id'))
  if (!w) return c.json({ error: 'no such workspace' }, 404)
  try {
    if (w.kind === 'cloudflare') {
      const api = ws.cloudflareFor(w.id)
      if (!api) return c.json({ kind: w.kind, ok: false, detail: 'Token missing from the keychain' })
      const p = await api.ping()
      return c.json({ kind: w.kind, ok: p.ok, detail: w.cloudflare?.url ?? '', storage: p.storage })
    }
    if (w.kind === 'remote') {
      const k = ws.supabaseFor(w.id)
      if (!k) return c.json({ kind: w.kind, ok: false, detail: 'Supabase keys missing from the keychain' })
      const { missingTables } = await import('./supabase-connect')
      const missing = await missingTables(k)
      return c.json({ kind: w.kind, ok: !missing.length, detail: k.url.replace(/^https:\/\//, ''), missing })
    }
    return c.json({ kind: w.kind, ok: true, detail: ws.dir(w.id) })
  } catch (e) {
    return c.json({ kind: w.kind, ok: false, detail: (e as Error).message })
  }
})

/* --- Composio: connections per workspace, and automations ------------------ */
app.get('/api/composio/status', async (c) => {
  if (PUBLIC) return c.json({ installed: false, loggedIn: false, email: '' })
  return c.json({ ...(await composio.status()), toolkits: composio.TOOLKITS })
})
app.get('/api/composio/accounts', async (c) => {
  if (PUBLIC) return c.json([])
  const toolkit = (c.req.query('toolkit') ?? '').replace(/[^a-z0-9_]/gi, '')
  if (!toolkit) return c.json({ error: 'toolkit required' }, 400)
  try {
    return c.json(await composio.accounts(toolkit))
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500)
  }
})
app.post('/api/composio/link', async (c) => {
  if (PUBLIC) return c.json({ error: 'not available' }, 404)
  const { toolkit, alias } = await c.req.json<{ toolkit: string; alias?: string }>()
  try {
    return c.json(await composio.linkUrl(toolkit.replace(/[^a-z0-9_]/gi, ''), alias?.replace(/[^a-z0-9_-]/gi, '')))
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500)
  }
})
app.post('/api/workspaces/:id/activate', (c) => {
  const w = ws.setActive(c.req.param('id'))
  return w ? c.json(ws.publicView(w)) : c.json({ error: 'no such workspace' }, 404)
})
app.delete('/api/workspaces/:id', async (c) =>
  c.json({ ok: await ws.remove(c.req.param('id')) }),
)

// Which Supabase project to sign in to depends on the workspace (?ws=).
if (!PUBLIC) {
  app.get('/config', (c) => {
    const id = c.req.query('ws') ?? c.req.header('x-workspace') ?? ws.active()?.id
    const k = id ? ws.supabaseFor(id) : null
    return c.json({
      supabaseUrl: k?.url ?? process.env.SUPABASE_URL,
      supabaseKey: k?.anonKey ?? process.env.SUPABASE_PUBLISHABLE_KEY,
      brand: process.env.CRM_BRAND ?? 'Alfredo',
      prefix: process.env.CRM_PREFIX ?? 'WS',
    })
  })
}

app.route('/api/v2', v2Routes(() => ctx.getStore() as any))

app.get('/health', (c) => c.json({ ok: true }))

// --- the built app ----------------------------------------------------------
// Only in the public build; locally Vite serves the SPA with hot reload.
// The packaged Mac app has no Vite either; it serves the same built files
// while keeping everything local (sessions, microphone, MCP).
const DESKTOP = process.env.ALFRED_DESKTOP === '1'
if (PUBLIC || DESKTOP) {
  // Hashed assets can live forever; the page itself must never be cached, or
  // an installed app keeps running the previous build out of Chromium's cache.
  app.use('/assets/*', async (c, next) => {
    await next()
    c.header('Cache-Control', 'public, max-age=31536000, immutable')
  })
  app.use('/assets/*', serveStatic({ root: './dist' }))
  app.use('*', async (c, next) => {
    await next()
    if (!c.req.path.startsWith('/assets/') && !c.req.path.startsWith('/api/')) c.header('Cache-Control', 'no-store')
  })
  app.get('/favicon.ico', serveStatic({ path: './dist/favicon.ico' }))
  // Anything not an API route is the SPA shell; there is no router, but a
  // refresh on any path should still land in the app rather than a 404.
  app.get('*', serveStatic({ path: './dist/index.html' }))
}

const hostname = PUBLIC ? '0.0.0.0' : '127.0.0.1'
serve({ fetch: app.fetch, port: PORT, hostname }, () => {
  console.log(
    PUBLIC
      ? `alfredo (public) → :${PORT}  [mcp disabled, recording is browser-side]`
      : `alfredo  →  http://127.0.0.1:${PORT}${MCP_PATH}  (workspace: ${ws.active()?.name ?? 'none'})`,
  )
})

// Never leave an orphaned ffmpeg holding the microphone.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (audio.isRecording()) audio.stop().catch(() => {})
    ws.closeAll().finally(() => process.exit(0))
  })
}
