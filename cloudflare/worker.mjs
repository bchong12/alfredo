// Alfredo on Cloudflare: a workspace database in your own account.
//
// D1 has no client auth of its own, so this Worker is the only door to it,
// and the door is where access is decided. Two kinds of caller get in:
//
//   the owner  ALFREDO_TOKEN, the secret set when the workspace was created.
//              Whoever holds it runs the workspace.
//   a person   a session from /auth/login or /auth/join, held in their Mac's
//              keychain. What they may read and write is decided here, from
//              the projects they are in: read, write, or not at all.
//
// The API Alfredo speaks:
//   GET  /api/workspace/session                  who this caller is
//   POST /api/workspace/auth/login               email and password -> a session
//   POST /api/workspace/auth/join                an invite -> an account and a session
//   GET  /api/workspace/members                  people      POST /invites makes a link
//   GET  /api/workspace/projects                 PUT /projects (admin), POST /projects/assign
//   GET  /api/workspace/items                    docs, boards (canvases), meetings
//   GET  /api/workspace/tasks                    board cards
//
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
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
const token = () => hex(crypto.getRandomValues(new Uint8Array(32)))
const sha = async (v) => hex(await crypto.subtle.digest('SHA-256', enc.encode(v)))
const STATUSES = ['todo', 'progress', 'review', 'done']
const TYPES = ['document', 'board', 'meeting']
const KIND_OF = { document: 'doc', board: 'canvas', meeting: 'meeting' }
const ROLES = ['admin', 'write', 'read']

/** Same digest either way, so a wrong token takes as long as a right one. */
async function same(a, b) {
  const [x, y] = await Promise.all([sha(a), sha(b)])
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i)
  return diff === 0
}

/** PBKDF2, so a stolen database is not a list of passwords. */
async function passwordHash(password, salt = token()) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: 100000 }, key, 256)
  return `${salt}:${hex(bits)}`
}
const passwordMatches = async (password, stored) => {
  if (!stored) return false
  const [salt] = stored.split(':')
  return same(await passwordHash(password, salt), stored)
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

// --- who is asking -----------------------------------------------------------

const OWNER = { id: 'owner', email: '', name: 'Owner', role: 'admin', owner: true }

async function caller(req, env) {
  const bearer = req.headers.get('authorization')?.replace(/^Bearer /, '') ?? ''
  if (!bearer) return null
  if (env.ALFREDO_TOKEN?.length >= 32 && (await same(bearer, env.ALFREDO_TOKEN))) {
    return { ...OWNER, email: env.OWNER_EMAIL || '', name: env.OWNER_NAME || 'Owner' }
  }
  const row = await env.DB.prepare(
    'SELECT u.id, u.email, u.name, u.role FROM ws_sessions s JOIN ws_users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?',
  )
    .bind(await sha(bearer), Date.now())
    .first()
  return row ? { ...row, owner: false } : null
}

const isAdmin = (who) => who.owner || who.role === 'admin'

/** The projects this caller may open, and what they may do in each. */
async function roles(env, who) {
  const projects = await rows(env.DB.prepare('SELECT * FROM ws_projects WHERE archived = 0 ORDER BY position'))
  if (isAdmin(who)) return new Map(projects.map((p) => [p.id, 'admin']))
  const mine = await rows(env.DB.prepare('SELECT project_id, role FROM ws_project_members WHERE user_id = ?').bind(who.id))
  return new Map(mine.filter((m) => projects.some((p) => p.id === m.project_id)).map((m) => [m.project_id, m.role]))
}

/** Where each item lives: "kind:id" -> project id. */
async function itemProjects(env) {
  const map = new Map()
  for (const r of await rows(env.DB.prepare('SELECT kind, item_id, project_id FROM ws_project_items'))) map.set(`${r.kind}:${r.item_id}`, r.project_id)
  return map
}

const mayRead = (mine, project) => !project || mine.has(project)
const mayWrite = (mine, project) => !project || ['admin', 'write'].includes(mine.get(project))

async function makeSession(env, userId) {
  const raw = token()
  await env.DB.prepare('INSERT INTO ws_sessions(token_hash, user_id, expires_at) VALUES(?,?,?)')
    .bind(await sha(raw), userId, Date.now() + 30 * 86400000)
    .run()
  return raw
}

// --- the API -----------------------------------------------------------------

async function api(req, env) {
  const url = new URL(req.url)
  const path = url.pathname.replace(/^\/api\/workspace/, '')
  const method = req.method
  const scope = req.headers.get('x-project') || url.searchParams.get('project') || ''
  const project = scope && scope !== 'all' ? scope : ''

  // Joining and signing in are the two doors that need no session yet.
  if (path === '/auth/login' && method === 'POST') {
    const b = await body(req)
    const user = await env.DB.prepare('SELECT * FROM ws_users WHERE lower(email) = lower(?)').bind(text(b.email)).first()
    if (!user || !(await passwordMatches(String(b.password ?? ''), user.password_hash))) fail('Email or password is incorrect.', 401)
    return json({ token: await makeSession(env, user.id), user: { id: user.id, email: user.email, name: user.name, role: user.role } })
  }
  if (path === '/auth/join' && method === 'POST') {
    const b = await body(req)
    const hash = await sha(String(b.invite ?? ''))
    const inv = await env.DB.prepare('SELECT * FROM ws_invites WHERE token_hash = ?').bind(hash).first()
    if (!inv || inv.used_at || inv.expires_at < Date.now()) fail('This invitation is no longer good. Ask for a new one.', 403)
    const password = String(b.password ?? '')
    if (password.length < 8) fail('Use a password of at least 8 characters.')
    const email = inv.email.toLowerCase()
    const name = text(b.name, 100) || email.split('@')[0]
    const have = await env.DB.prepare('SELECT * FROM ws_users WHERE lower(email) = lower(?)').bind(email).first()
    const id = have?.id ?? crypto.randomUUID()
    const hashed = await passwordHash(password)
    if (have) await env.DB.prepare('UPDATE ws_users SET name = ?, role = ?, password_hash = ? WHERE id = ?').bind(name, inv.role, hashed, id).run()
    else await env.DB.prepare('INSERT INTO ws_users(id,email,name,role,password_hash,created_at) VALUES(?,?,?,?,?,?)').bind(id, email, name, inv.role, hashed, now()).run()
    for (const p of JSON.parse(inv.projects || '[]')) {
      await env.DB.prepare('INSERT INTO ws_project_members(project_id,user_id,role) VALUES(?,?,?) ON CONFLICT(project_id,user_id) DO UPDATE SET role = excluded.role')
        .bind(p.id, id, ROLES.includes(p.role) ? p.role : 'write')
        .run()
    }
    await env.DB.prepare('UPDATE ws_invites SET used_at = ? WHERE id = ?').bind(now(), inv.id).run()
    return json({ token: await makeSession(env, id), user: { id, email, name, role: inv.role } })
  }

  const who = await caller(req, env)
  if (path === '/session') return json({ user: who ? { id: who.id, email: who.email, name: who.name, role: who.role } : null, storage: 'cloudflare' })
  if (!who) fail('Not signed in.', 401)

  const mine = await roles(env, who)
  const where = await itemProjects(env)
  if (project && !mine.has(project)) fail('You do not have access to that project.', 403)

  // Where a piece of work belongs, and whether this caller may see or change
  // it. Every section below asks these, so they live above all of them.
  const place = async (kind, id) => {
    if (!project) return
    await env.DB.prepare('INSERT INTO ws_project_items(kind,item_id,project_id) VALUES(?,?,?) ON CONFLICT(kind,item_id) DO UPDATE SET project_id = excluded.project_id')
      .bind(kind, id, project)
      .run()
  }
  const visible = (kind, id) => {
    const p = where.get(`${kind}:${id}`)
    return project ? p === project : mayRead(mine, p)
  }
  const writable = (kind, id) => mayWrite(mine, where.get(`${kind}:${id}`))

  // --- people and invitations
  if (path === '/members' && method === 'GET') {
    const people = await rows(env.DB.prepare('SELECT id, email, name, role FROM ws_users ORDER BY name'))
    if (who.owner && !people.some((p) => p.id === 'owner')) people.unshift({ id: 'owner', email: who.email, name: who.name, role: 'admin' })
    return json(people)
  }
  if (path === '/invites' && method === 'GET') {
    if (!isAdmin(who)) fail('Only an admin can see the invitations.', 403)
    const list = await rows(env.DB.prepare('SELECT id, email, role, projects, expires_at, used_at FROM ws_invites ORDER BY rowid DESC'))
    return json(list.map((i) => ({ ...i, projects: JSON.parse(i.projects || '[]') })))
  }
  if (path === '/invites' && method === 'POST') {
    if (!isAdmin(who)) fail('Only an admin can invite people.', 403)
    const b = await body(req)
    const email = text(b.email).toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('Enter a valid email.')
    const projects = (Array.isArray(b.projects) ? b.projects : []).filter((p) => p && typeof p.id === 'string')
    const raw = token()
    const id = crypto.randomUUID()
    await env.DB.prepare('INSERT INTO ws_invites(id,token_hash,email,role,projects,expires_at) VALUES(?,?,?,?,?,?)')
      .bind(id, await sha(raw), email, b.role === 'admin' ? 'admin' : 'member', JSON.stringify(projects), Date.now() + 14 * 86400000)
      .run()
    return json({ token: raw, invite: { id, email, role: b.role === 'admin' ? 'admin' : 'member', projects, usedAt: null } }, 201)
  }
  const invite = path.match(/^\/invites\/([^/]+)$/)
  if (invite && method === 'DELETE') {
    if (!isAdmin(who)) fail('Only an admin can revoke an invitation.', 403)
    await env.DB.prepare('DELETE FROM ws_invites WHERE id = ?').bind(invite[1]).run()
    return json({ ok: true })
  }
  const member = path.match(/^\/members\/([^/]+)$/)
  if (member && method === 'PATCH') {
    if (!isAdmin(who)) fail('Only an admin can change what someone may do.', 403)
    const b = await body(req)
    if (b.role) await env.DB.prepare('UPDATE ws_users SET role = ? WHERE id = ?').bind(b.role === 'admin' ? 'admin' : 'member', member[1]).run()
    return json({ ok: true })
  }

  // --- projects
  if (path === '/projects' && method === 'GET') {
    const all = await rows(env.DB.prepare('SELECT * FROM ws_projects ORDER BY position'))
    const members = await rows(env.DB.prepare('SELECT project_id, user_id, role FROM ws_project_members'))
    const seen = all
      .filter((p) => mine.has(p.id))
      .map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        ...(p.archived ? { archived: true } : {}),
        role: mine.get(p.id),
        members: isAdmin(who) ? members.filter((m) => m.project_id === p.id).map((m) => ({ personId: m.user_id, role: m.role })) : undefined,
      }))
    return json({ projects: seen, canManage: isAdmin(who), me: who.id })
  }
  if (path === '/project-items' && method === 'GET') {
    const all = await rows(env.DB.prepare('SELECT kind, item_id, project_id FROM ws_project_items'))
    return json(Object.fromEntries(all.filter((r) => mine.has(r.project_id)).map((r) => [`${r.kind}:${r.item_id}`, r.project_id])))
  }
  if (path === '/projects' && method === 'PUT') {
    if (!isAdmin(who)) fail('Only an admin can change the projects here.', 403)
    const b = await body(req)
    const list = Array.isArray(b.projects) ? b.projects : []
    const before = await rows(env.DB.prepare('SELECT id FROM ws_projects'))
    for (const p of before) if (!list.some((x) => x.id === p.id)) await env.DB.prepare('DELETE FROM ws_projects WHERE id = ?').bind(p.id).run()
    for (const [i, p] of list.entries()) {
      const id = p.id || crypto.randomUUID()
      await env.DB.prepare(
        'INSERT INTO ws_projects(id,name,color,position,archived,created_at) VALUES(?,?,?,?,?,?) ' +
          'ON CONFLICT(id) DO UPDATE SET name = excluded.name, color = excluded.color, position = excluded.position, archived = excluded.archived',
      )
        .bind(id, text(p.name, 60) || 'Project', text(p.color, 20) || 'slate', i, p.archived ? 1 : 0, now())
        .run()
      await env.DB.prepare('DELETE FROM ws_project_members WHERE project_id = ?').bind(id).run()
      for (const m of p.members ?? []) {
        if (!m?.personId) continue
        await env.DB.prepare('INSERT INTO ws_project_members(project_id,user_id,role) VALUES(?,?,?)')
          .bind(id, m.personId, ROLES.includes(m.role) ? m.role : 'write')
          .run()
      }
    }
    return json({ ok: true })
  }
  if (path === '/projects/assign' && method === 'POST') {
    const b = await body(req)
    const ids = Array.isArray(b.ids) ? b.ids : []
    const to = b.project || null
    if (to && !mayWrite(mine, to)) fail('You cannot put things into that project.', 403)
    for (const id of ids) {
      const from = where.get(`${b.kind}:${id}`)
      if (from && !mayWrite(mine, from)) fail('You have read-only access to what you are moving.', 403)
      await env.DB.prepare('DELETE FROM ws_project_items WHERE kind = ? AND item_id = ?').bind(b.kind, id).run()
      if (to) await env.DB.prepare('INSERT INTO ws_project_items(kind,item_id,project_id) VALUES(?,?,?)').bind(b.kind, id, to).run()
    }
    return json({ ok: true })
  }

  // --- what the workspace knows
  //
  // The Mac does the embedding and sends the vectors; the Worker keeps them
  // beside the writing and scores them, so a question only ever sees the
  // projects this caller is in.
  if (path === '/chunks' && method === 'PUT') {
    const b = await body(req)
    const kind = text(b.kind, 20), itemId = text(b.itemId, 80)
    if (!kind || !itemId) fail('Say which item these belong to.')
    if (!writable(kind, itemId)) fail('You have read-only access to this project.', 403)
    await env.DB.prepare('DELETE FROM ws_chunks WHERE kind = ? AND item_id = ?').bind(kind, itemId).run()
    for (const c of b.chunks ?? []) {
      const bytes = new Float32Array(c.embedding ?? []).buffer
      await env.DB.prepare('INSERT INTO ws_chunks(kind,item_id,ord,title,heading,text,embedding,updated_at) VALUES(?,?,?,?,?,?,?,?)')
        .bind(kind, itemId, c.ord ?? 0, text(c.title, 300), text(c.heading, 300), String(c.text ?? '').slice(0, 8000), bytes, now())
        .run()
    }
    return json({ ok: true, chunks: (b.chunks ?? []).length })
  }
  if (path === '/chunks' && method === 'DELETE') {
    const b = await body(req)
    await env.DB.prepare('DELETE FROM ws_chunks WHERE kind = ? AND item_id = ?').bind(text(b.kind, 20), text(b.itemId, 80)).run()
    return json({ ok: true })
  }
  if (path === '/chunks/count' && method === 'GET') {
    const r = await env.DB.prepare('SELECT count(*) AS n FROM ws_chunks').first()
    return json({ count: r?.n ?? 0 })
  }
  if (path === '/chunks/search' && method === 'POST') {
    const b = await body(req)
    const want = new Float32Array(b.vector ?? [])
    const words = String(b.text ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2)
    const limit = Math.min(Math.max(Number(b.limit) || 12, 1), 50)
    const all = await rows(env.DB.prepare('SELECT kind, item_id, ord, title, heading, text, embedding FROM ws_chunks'))
    const dense = [], lexical = []
    for (const r of all) {
      if (!visible(r.kind, r.item_id)) continue
      let dot = 0
      if (r.embedding && want.length) {
        const v = new Float32Array(r.embedding)
        const n = Math.min(v.length, want.length)
        for (let i = 0; i < n; i++) dot += v[i] * want[i]
      }
      // The word half: how much of the question this chunk actually says.
      const hay = `${r.title} ${r.heading} ${r.text}`.toLowerCase()
      const hits = words.filter((w) => hay.includes(w)).length
      dense.push({ r, dot })
      if (hits) lexical.push({ r, hits })
    }
    dense.sort((a, b2) => b2.dot - a.dot)
    lexical.sort((a, b2) => b2.hits - a.hits)
    // Reciprocal rank fusion, the same as the Postgres side.
    const key = (r) => `${r.kind}:${r.item_id}:${r.ord}`
    const score = new Map()
    dense.slice(0, limit * 4).forEach(({ r }, i) => score.set(key(r), { r, s: (score.get(key(r))?.s ?? 0) + 1 / (60 + i + 1) }))
    lexical.slice(0, limit * 4).forEach(({ r }, i) => score.set(key(r), { r, s: (score.get(key(r))?.s ?? 0) + 1 / (60 + i + 1) }))
    const best = [...score.values()].sort((a, b2) => b2.s - a.s).slice(0, limit)
    return json(best.map(({ r, s }) => ({ kind: r.kind, itemId: r.item_id, ord: r.ord, title: r.title, heading: r.heading, text: r.text, score: s })))
  }

  // --- documents, boards and meetings

  async function findItem(id) {
    const row = await env.DB.prepare('SELECT * FROM ws_items WHERE id=? AND archived=0').bind(id).first()
    if (!row) fail('Not found.', 404)
    const kind = KIND_OF[row.type]
    if (!visible(kind, row.id)) fail('Not found.', 404)
    return { ...row, content: JSON.parse(row.content), kind }
  }

  if (path === '/items' && method === 'GET') {
    const all = await rows(env.DB.prepare('SELECT id,type,title,icon,revision,created_by,created_at,updated_at FROM ws_items WHERE archived=0 ORDER BY updated_at DESC'))
    return json(all.filter((i) => visible(KIND_OF[i.type], i.id)).map((i) => ({ ...i, project: where.get(`${KIND_OF[i.type]}:${i.id}`) ?? null })))
  }
  if (path === '/items' && method === 'POST') {
    const b = await body(req)
    if (!TYPES.includes(b.type)) fail('Choose document, board, or meeting.')
    if (project && !mayWrite(mine, project)) fail('You have read-only access to this project.', 403)
    const id = crypto.randomUUID(), stamp = now(), title = text(b.title) || `Untitled ${b.type}`
    const content = b.content || (b.type === 'board' ? { title, revision: 1, nodes: [], edges: [] } : { doc: { type: 'doc', content: [{ type: 'paragraph' }] } })
    await env.DB.prepare('INSERT INTO ws_items(id,type,title,content,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .bind(id, b.type, title, JSON.stringify(content), who.id, stamp, stamp)
      .run()
    await place(KIND_OF[b.type], id)
    where.set(`${KIND_OF[b.type]}:${id}`, project || undefined)
    return json(await findItem(id), 201)
  }
  const item = path.match(/^\/items\/([^/]+)(\/board)?$/)
  if (item) {
    const [, id, board] = item
    const cur = await findItem(id)
    const change = () => {
      if (!writable(cur.kind, id)) fail('You have read-only access to this project.', 403)
    }
    if (board) {
      if (cur.type !== 'board') fail('This item is not a board.')
      if (method === 'GET') return json(cur.content)
      if (method === 'PUT') {
        change()
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
    if (method === 'GET') return json({ ...cur, project: where.get(`${cur.kind}:${id}`) ?? null })
    if (method === 'PUT') {
      change()
      const b = await body(req)
      if (b.revision !== cur.revision) fail('Someone updated this. Reload before saving.', 409)
      const r = await env.DB.prepare('UPDATE ws_items SET title=?,content=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?')
        .bind(text(b.title) || 'Untitled', JSON.stringify(b.content ?? cur.content), now(), id, cur.revision)
        .run()
      if (r.meta.changes !== 1) fail('Someone updated this. Reload before saving.', 409)
      return json(await findItem(id))
    }
    if (method === 'DELETE') {
      change()
      await env.DB.prepare('UPDATE ws_items SET archived=1,updated_at=? WHERE id=?').bind(now(), id).run()
      return json({ ok: true })
    }
  }

  // --- board cards
  if (path === '/tasks' && method === 'GET') {
    const all = await rows(env.DB.prepare('SELECT * FROM ws_tasks WHERE archived=0 ORDER BY created_at'))
    return json(all.filter((t) => visible('card', t.id)).map((t) => ({ ...t, project: where.get(`card:${t.id}`) ?? null })))
  }
  if (path === '/tasks' && method === 'POST') {
    const b = await body(req)
    const title = text(b.title, 300)
    if (!title) fail('Add a task title.')
    if (project && !mayWrite(mine, project)) fail('You have read-only access to this project.', 403)
    const id = crypto.randomUUID(), stamp = now()
    await env.DB.prepare('INSERT INTO ws_tasks(id,title,status,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?)')
      .bind(id, title, STATUSES.includes(b.status) ? b.status : 'todo', who.id, stamp, stamp)
      .run()
    await place('card', id)
    const made = await env.DB.prepare('SELECT * FROM ws_tasks WHERE id=?').bind(id).first()
    return json({ ...made, project: project || null }, 201)
  }
  const task = path.match(/^\/tasks\/([^/]+)$/)
  if (task && (method === 'PUT' || method === 'DELETE')) {
    if (!visible('card', task[1])) fail('Not found.', 404)
    if (!writable('card', task[1])) fail('You have read-only access to this project.', 403)
    if (method === 'DELETE') {
      await env.DB.prepare('UPDATE ws_tasks SET archived=1 WHERE id=?').bind(task[1]).run()
      return json({ ok: true })
    }
    const b = await body(req)
    if (!STATUSES.includes(b.status) || !['low', 'medium', 'high'].includes(b.priority) || !text(b.title)) fail('Invalid task.')
    const r = await env.DB.prepare(
      'UPDATE ws_tasks SET title=?,description=?,status=?,priority=?,assignee=?,due_date=?,linked_item=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND archived=0',
    )
      .bind(text(b.title, 300), text(b.description, 10000), b.status, b.priority, text(b.assignee), text(b.due_date, 10), text(b.linked_item), now(), task[1], b.revision)
      .run()
    if (r.meta.changes !== 1) fail('This task changed elsewhere. Reload and try again.', 409)
    const after = await env.DB.prepare('SELECT * FROM ws_tasks WHERE id=?').bind(task[1]).first()
    return json({ ...after, project: where.get(`card:${task[1]}`) ?? null })
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
