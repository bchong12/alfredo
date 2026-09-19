// Alfredo on Cloudflare: a workspace database in your own account.
//
// D1 has no client auth of its own, so this Worker is the only door to it.
// Alfredo (the desktop app, and through it the MCP) calls it with the
// ALFREDO_TOKEN secret; nobody else gets in. The API is the one Alfredo's
// Cloudflare store speaks:
//   GET  /api/workspace/session              who the token is
//   GET  /api/workspace/members              people   POST /invites adds one
//   GET  /api/workspace/items                docs, boards (canvases), meetings
//   POST /api/workspace/items                GET|PUT|DELETE /items/:id, GET|PUT /items/:id/board
//   GET  /api/workspace/tasks                board cards (todo|progress|review|done)
//   POST /api/workspace/tasks                PUT|DELETE /tasks/:id
// Deploy it from Alfredo (Settings > Database > Create on Cloudflare) or by hand:
//   wrangler d1 create alfredo && wrangler d1 execute alfredo --remote --file schema.sql
//   wrangler deploy && wrangler secret put ALFREDO_TOKEN

const enc = new TextEncoder()
const now = () => new Date().toISOString()
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
const fail = (message, status = 400) => {
  throw Object.assign(new Error(message), { status })
}
const text = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const rows = async (st) => (await st.all()).results
const STATUSES = ['todo', 'progress', 'review', 'done']
const TYPES = ['document', 'board', 'meeting']

async function same(a, b) {
  // Compare digests so the check takes the same time whatever the input.
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))])
  const u = new Uint8Array(x), v = new Uint8Array(y)
  let diff = 0
  for (let i = 0; i < u.length; i++) diff |= u[i] ^ v[i]
  return diff === 0
}

async function body(req) {
  const raw = await req.text()
  if (enc.encode(raw).length > 5_000_000) fail('This is too large.', 413)
  try {
    return JSON.parse(raw || '{}')
  } catch {
    fail('Invalid request.')
  }
}

async function findItem(env, id) {
  const row = await env.DB.prepare('SELECT * FROM ws_items WHERE id=? AND archived=0').bind(id).first()
  if (!row) fail('Not found.', 404)
  return { ...row, content: JSON.parse(row.content) }
}

async function api(req, env) {
  const url = new URL(req.url)
  const path = url.pathname.replace(/^\/api\/workspace/, '')
  const method = req.method
  const bearer = req.headers.get('authorization')?.replace(/^Bearer /, '') ?? ''
  const ok = env.ALFREDO_TOKEN?.length >= 32 && (await same(bearer, env.ALFREDO_TOKEN))
  const owner = { id: 'owner', email: env.OWNER_EMAIL || 'owner@alfredo.local', name: env.OWNER_NAME || 'Owner', role: 'owner' }

  if (path === '/session') return json({ user: ok ? owner : null, storage: 'cloudflare' })
  if (!ok) fail('Not signed in.', 401)

  if (path === '/members' && method === 'GET') {
    const people = await rows(env.DB.prepare('SELECT id,email,name,role FROM ws_users ORDER BY name'))
    if (!people.some((p) => p.email === owner.email)) people.unshift(owner)
    return json(people)
  }
  if (path === '/invites' && method === 'POST') {
    const b = await body(req)
    const email = text(b.email).toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('Enter a valid email.')
    const name = email.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
    await env.DB.prepare('INSERT INTO ws_users(id,email,name,role,created_at) VALUES(?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET role=excluded.role')
      .bind(crypto.randomUUID(), email, name, b.role === 'viewer' ? 'viewer' : 'editor', now())
      .run()
    // People reach this workspace through Alfredo, so there is no sign-up link to send.
    return json({ token: null, email }, 201)
  }

  if (path === '/items' && method === 'GET')
    return json(await rows(env.DB.prepare('SELECT id,type,title,icon,revision,created_by,created_at,updated_at FROM ws_items WHERE archived=0 ORDER BY updated_at DESC')))
  if (path === '/items' && method === 'POST') {
    const b = await body(req)
    if (!TYPES.includes(b.type)) fail('Choose document, board, or meeting.')
    const id = crypto.randomUUID(), stamp = now(), title = text(b.title) || `Untitled ${b.type}`
    const content = b.content || (b.type === 'board' ? { title, revision: 1, nodes: [], edges: [] } : { doc: { type: 'doc', content: [{ type: 'paragraph' }] } })
    await env.DB.prepare('INSERT INTO ws_items(id,type,title,content,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .bind(id, b.type, title, JSON.stringify(content), owner.id, stamp, stamp)
      .run()
    return json(await findItem(env, id), 201)
  }
  const item = path.match(/^\/items\/([^/]+)(\/board)?$/)
  if (item) {
    const [, id, board] = item
    const cur = await findItem(env, id)
    if (board) {
      if (cur.type !== 'board') fail('This item is not a board.')
      if (method === 'GET') return json(cur.content)
      if (method === 'PUT') {
        const b = await body(req)
        if (!Array.isArray(b.nodes) || !Array.isArray(b.edges)) fail('Invalid board.')
        if (b.revision !== cur.content.revision) fail('Board changed elsewhere. Reload before editing.', 409)
        const next = { ...b, revision: b.revision + 1, updatedAt: now() }
        const r = await env.DB.prepare('UPDATE ws_items SET content=?,title=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?')
          .bind(JSON.stringify(next), text(b.title) || cur.title, now(), id, cur.revision)
          .run()
        if (r.meta.changes !== 1) fail('Board changed elsewhere. Reload before editing.', 409)
        return json(next)
      }
    }
    if (method === 'GET') return json(cur)
    if (method === 'PUT') {
      const b = await body(req)
      if (b.revision !== cur.revision) fail('Someone updated this. Reload before saving.', 409)
      const r = await env.DB.prepare('UPDATE ws_items SET title=?,content=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?')
        .bind(text(b.title) || 'Untitled', JSON.stringify(b.content ?? cur.content), now(), id, cur.revision)
        .run()
      if (r.meta.changes !== 1) fail('Someone updated this. Reload before saving.', 409)
      return json(await findItem(env, id))
    }
    if (method === 'DELETE') {
      await env.DB.prepare('UPDATE ws_items SET archived=1,updated_at=? WHERE id=?').bind(now(), id).run()
      return json({ ok: true })
    }
  }

  if (path === '/tasks' && method === 'GET') return json(await rows(env.DB.prepare('SELECT * FROM ws_tasks WHERE archived=0 ORDER BY created_at')))
  if (path === '/tasks' && method === 'POST') {
    const b = await body(req)
    const title = text(b.title, 300)
    if (!title) fail('Add a task title.')
    const id = crypto.randomUUID(), stamp = now()
    await env.DB.prepare('INSERT INTO ws_tasks(id,title,status,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?)')
      .bind(id, title, STATUSES.includes(b.status) ? b.status : 'todo', owner.id, stamp, stamp)
      .run()
    return json(await env.DB.prepare('SELECT * FROM ws_tasks WHERE id=?').bind(id).first(), 201)
  }
  const task = path.match(/^\/tasks\/([^/]+)$/)
  if (task && method === 'PUT') {
    const b = await body(req)
    if (!STATUSES.includes(b.status) || !['low', 'medium', 'high'].includes(b.priority) || !text(b.title)) fail('Invalid task.')
    const r = await env.DB.prepare(
      'UPDATE ws_tasks SET title=?,description=?,status=?,priority=?,assignee=?,due_date=?,linked_item=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND archived=0',
    )
      .bind(text(b.title, 300), text(b.description, 10000), b.status, b.priority, text(b.assignee), text(b.due_date, 10), text(b.linked_item), now(), task[1], b.revision)
      .run()
    if (r.meta.changes !== 1) fail('This task changed elsewhere. Reload and try again.', 409)
    return json(await env.DB.prepare('SELECT * FROM ws_tasks WHERE id=?').bind(task[1]).first())
  }
  if (task && method === 'DELETE') {
    await env.DB.prepare('UPDATE ws_tasks SET archived=1 WHERE id=?').bind(task[1]).run()
    return json({ ok: true })
  }
  fail('Not found.', 404)
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url)
    if (!url.pathname.startsWith('/api/workspace')) return new Response('Alfredo workspace. Open it in the Alfredo app.', { status: 200 })
    try {
      return await api(req, env)
    } catch (e) {
      return json({ error: e.message || 'Request failed.' }, e.status || 500)
    }
  },
}
