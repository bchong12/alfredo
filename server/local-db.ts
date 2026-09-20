// A local workspace's database: Postgres, running in-process, on disk.
//
// This speaks the same query-builder dialect as supabase-js, so every route,
// MCP tool and pipeline in this codebase runs unchanged against a folder on
// your Mac. That was the whole point: the alternative was rewriting ~110 call
// sites into a storage interface and then keeping two implementations honest.
// Here there is one implementation (the routes) and one translation (this
// file), and shared workspaces keep talking to real Supabase.
//
// It is not PostgREST. It implements the subset this codebase actually uses,
// enumerated by grepping: select/insert/update/upsert/delete; eq/neq/is/in/lt/
// like/ilike/contains/textSearch; order/limit/single/maybeSingle; exact
// counts; and resource embedding (`select('*, summaries(*)')`) resolved from
// the schema's foreign keys. Anything outside that throws loudly rather than
// returning something plausible.

import { PGlite } from '@electric-sql/pglite'
import { vector } from '@electric-sql/pglite-pgvector'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

type Row = Record<string, unknown>
type Result<T> = { data: T; error: { message: string; code?: string } | null; count?: number | null }

type Filter =
  | { kind: 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte' | 'like' | 'ilike'; col: string; val: unknown }
  | { kind: 'is'; col: string; val: null | boolean }
  | { kind: 'in'; col: string; val: unknown[] }
  | { kind: 'contains'; col: string; val: unknown[] }
  | { kind: 'fts'; col: string; val: string }

type Embed = { name: string; cols: string[]; embeds: Embed[] }

import { LOCAL_USER } from './local-user'
export { LOCAL_USER }

// --- schema introspection --------------------------------------------------

type FK = { table: string; col: string; refTable: string; refCol: string }

class Schema {
  fks: FK[] = []
  pks = new Map<string, string[]>()
  types = new Map<string, Map<string, string>>()

  async load(pg: PGlite) {
    const fk = await pg.query<{ table: string; col: string; ref_table: string; ref_col: string }>(`
      select tc.table_name as "table", kcu.column_name as col,
             ccu.table_name as ref_table, ccu.column_name as ref_col
      from information_schema.table_constraints tc
      join information_schema.key_column_usage kcu on tc.constraint_name = kcu.constraint_name
      join information_schema.constraint_column_usage ccu on tc.constraint_name = ccu.constraint_name
      where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = 'public'`)
    this.fks = fk.rows.map((r) => ({ table: r.table, col: r.col, refTable: r.ref_table, refCol: r.ref_col }))

    const pk = await pg.query<{ table: string; col: string }>(`
      select tc.table_name as "table", kcu.column_name as col
      from information_schema.table_constraints tc
      join information_schema.key_column_usage kcu on tc.constraint_name = kcu.constraint_name
      where tc.constraint_type = 'PRIMARY KEY' and tc.table_schema = 'public'
      order by kcu.ordinal_position`)
    for (const r of pk.rows) this.pks.set(r.table, [...(this.pks.get(r.table) ?? []), r.col])

    const ty = await pg.query<{ table: string; col: string; type: string }>(`
      select table_name as "table", column_name as col, data_type as type
      from information_schema.columns where table_schema = 'public'`)
    for (const r of ty.rows) {
      if (!this.types.has(r.table)) this.types.set(r.table, new Map())
      this.types.get(r.table)!.set(r.col, r.type)
    }
  }

  /** How `table` reaches `rel`, or null if the schema has no such edge. */
  relation(table: string, rel: string) {
    const forward = this.fks.find((f) => f.table === table && f.refTable === rel)
    if (forward) return { dir: 'forward' as const, ...forward }
    const reverse = this.fks.find((f) => f.table === rel && f.refTable === table)
    if (reverse) {
      // PostgREST returns an embedded one-to-one as an object when the
      // foreign key is the child's whole primary key, and an array otherwise.
      const pk = this.pks.get(rel) ?? []
      const one = pk.length === 1 && pk[0] === reverse.col
      return { dir: 'reverse' as const, one, ...reverse }
    }
    return null
  }
}

// --- select-string parsing --------------------------------------------------

/** `*, summaries(*), roadmap_cards(card_id, cards(id,title))` → columns + embeds. */
function parseSelect(s: string): { cols: string[]; embeds: Embed[] } {
  const cols: string[] = []
  const embeds: Embed[] = []
  let depth = 0
  let cur = ''
  const flush = () => {
    const t = cur.trim()
    cur = ''
    if (!t) return
    const m = /^([a-zA-Z_][\w]*)\s*\((.*)\)$/s.exec(t)
    if (m) {
      const inner = parseSelect(m[2])
      embeds.push({ name: m[1], cols: inner.cols, embeds: inner.embeds })
    } else cols.push(t)
  }
  for (const ch of s) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) flush()
    else cur += ch
  }
  flush()
  return { cols, embeds }
}

// --- the builder ------------------------------------------------------------

class Query implements PromiseLike<Result<any>> {
  private op: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select'
  private sel = '*'
  private payload: Row | Row[] | null = null
  private filters: Filter[] = []
  private orders: { col: string; asc: boolean }[] = []
  private lim: number | null = null
  private mode: 'many' | 'single' | 'maybe' = 'many'
  private wantCount = false
  private headOnly = false

  constructor(private db: LocalDb, private table: string) {}

  select(cols = '*', opts?: { count?: 'exact'; head?: boolean }) {
    this.sel = cols
    if (opts?.count) this.wantCount = true
    if (opts?.head) this.headOnly = true
    return this
  }
  insert(rows: Row | Row[]) { this.op = 'insert'; this.payload = rows; return this }
  upsert(rows: Row | Row[]) { this.op = 'upsert'; this.payload = rows; return this }
  update(patch: Row) { this.op = 'update'; this.payload = patch; return this }
  delete() { this.op = 'delete'; return this }

  eq(col: string, val: unknown) { this.filters.push({ kind: 'eq', col, val }); return this }
  neq(col: string, val: unknown) { this.filters.push({ kind: 'neq', col, val }); return this }
  lt(col: string, val: unknown) { this.filters.push({ kind: 'lt', col, val }); return this }
  lte(col: string, val: unknown) { this.filters.push({ kind: 'lte', col, val }); return this }
  gt(col: string, val: unknown) { this.filters.push({ kind: 'gt', col, val }); return this }
  gte(col: string, val: unknown) { this.filters.push({ kind: 'gte', col, val }); return this }
  like(col: string, val: string) { this.filters.push({ kind: 'like', col, val }); return this }
  ilike(col: string, val: string) { this.filters.push({ kind: 'ilike', col, val }); return this }
  is(col: string, val: null | boolean) { this.filters.push({ kind: 'is', col, val }); return this }
  in(col: string, val: unknown[]) { this.filters.push({ kind: 'in', col, val }); return this }
  contains(col: string, val: unknown[]) { this.filters.push({ kind: 'contains', col, val }); return this }
  textSearch(col: string, val: string, _o?: { type?: string }) {
    this.filters.push({ kind: 'fts', col, val }); return this
  }
  not(col: string, op: string, val: unknown) {
    if (op === 'is' && val === null) { this.filters.push({ kind: 'neq', col, val: null }); return this }
    throw new Error(`local-db: .not('${col}', '${op}', …) is not supported`)
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this.orders.push({ col, asc: opts?.ascending !== false }); return this
  }
  limit(n: number) { this.lim = n; return this }
  single() { this.mode = 'single'; return this }
  maybeSingle() { this.mode = 'maybe'; return this }

  then<R1 = Result<any>, R2 = never>(
    ok?: ((v: Result<any>) => R1 | PromiseLike<R1>) | null,
    err?: ((e: unknown) => R2 | PromiseLike<R2>) | null,
  ) {
    return this.run().then(ok ?? undefined, err ?? undefined)
  }

  private where(params: unknown[]) {
    const parts: string[] = []
    for (const f of this.filters) {
      const c = `"${f.col}"`
      switch (f.kind) {
        case 'eq': params.push(f.val); parts.push(`${c} = $${params.length}`); break
        case 'neq':
          if (f.val === null) parts.push(`${c} IS NOT NULL`)
          else { params.push(f.val); parts.push(`${c} <> $${params.length}`) }
          break
        case 'lt': params.push(f.val); parts.push(`${c} < $${params.length}`); break
        case 'lte': params.push(f.val); parts.push(`${c} <= $${params.length}`); break
        case 'gt': params.push(f.val); parts.push(`${c} > $${params.length}`); break
        case 'gte': params.push(f.val); parts.push(`${c} >= $${params.length}`); break
        case 'like': params.push(f.val); parts.push(`${c} LIKE $${params.length}`); break
        case 'ilike': params.push(f.val); parts.push(`${c} ILIKE $${params.length}`); break
        case 'is':
          parts.push(f.val === null ? `${c} IS NULL` : `${c} IS ${f.val ? 'TRUE' : 'FALSE'}`)
          break
        case 'in': params.push(f.val); parts.push(`${c} = ANY($${params.length})`); break
        case 'contains': params.push(f.val); parts.push(`${c} @> $${params.length}`); break
        case 'fts':
          params.push(f.val)
          parts.push(`${c} @@ websearch_to_tsquery('english', $${params.length})`)
          break
      }
    }
    return parts.length ? ` WHERE ${parts.join(' AND ')}` : ''
  }

  private async run(): Promise<Result<any>> {
    try {
      const rows = await this.exec()
      if (this.headOnly) return { data: null, error: null, count: rows.length }
      const shaped = await this.db.embed(this.table, rows, parseSelect(this.sel))
      const count = this.wantCount ? shaped.length : undefined
      if (this.mode === 'single') {
        if (shaped.length !== 1) {
          return {
            data: null,
            error: { message: `Expected exactly one row, got ${shaped.length}`, code: 'PGRST116' },
            count,
          }
        }
        return { data: shaped[0], error: null, count }
      }
      if (this.mode === 'maybe') {
        if (shaped.length > 1) return { data: null, error: { message: 'Expected at most one row' }, count }
        return { data: shaped[0] ?? null, error: null, count }
      }
      return { data: shaped, error: null, count }
    } catch (e) {
      return { data: null, error: { message: e instanceof Error ? e.message : String(e) } }
    }
  }

  private async exec(): Promise<Row[]> {
    const t = `"${this.table}"`
    const params: unknown[] = []

    if (this.op === 'select') {
      if (this.headOnly) {
        const r = await this.db.pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}${this.where(params)}`, params)
        return new Array(r.rows[0]?.n ?? 0).fill({})
      }
      const order = this.orders.length
        ? ` ORDER BY ${this.orders.map((o) => `"${o.col}" ${o.asc ? 'ASC' : 'DESC'}`).join(', ')}`
        : ''
      const limit = this.lim != null ? ` LIMIT ${Number(this.lim)}` : ''
      const r = await this.db.pg.query<Row>(`SELECT * FROM ${t}${this.where(params)}${order}${limit}`, params)
      return r.rows
    }

    if (this.op === 'insert' || this.op === 'upsert') {
      const list = Array.isArray(this.payload) ? this.payload : [this.payload as Row]
      if (!list.length) return []
      const cols = [...new Set(list.flatMap((r) => Object.keys(r)))]
      const values: string[] = []
      for (const row of list) {
        const ph: string[] = []
        for (const c of cols) {
          params.push(this.db.encode(this.table, c, row[c]))
          ph.push(`$${params.length}`)
        }
        values.push(`(${ph.join(', ')})`)
      }
      let sql = `INSERT INTO ${t} (${cols.map((c) => `"${c}"`).join(', ')}) VALUES ${values.join(', ')}`
      if (this.op === 'upsert') {
        const pk = this.db.schema.pks.get(this.table)
        if (!pk?.length) throw new Error(`local-db: upsert on ${this.table} needs a primary key`)
        const set = cols.filter((c) => !pk.includes(c)).map((c) => `"${c}" = EXCLUDED."${c}"`)
        sql += ` ON CONFLICT (${pk.map((c) => `"${c}"`).join(', ')}) ${set.length ? `DO UPDATE SET ${set.join(', ')}` : 'DO NOTHING'}`
      }
      const r = await this.db.pg.query<Row>(sql + ' RETURNING *', params)
      return r.rows
    }

    if (this.op === 'update') {
      const patch = this.payload as Row
      const set: string[] = []
      for (const [c, v] of Object.entries(patch)) {
        params.push(this.db.encode(this.table, c, v))
        set.push(`"${c}" = $${params.length}`)
      }
      if (!set.length) return []
      const r = await this.db.pg.query<Row>(`UPDATE ${t} SET ${set.join(', ')}${this.where(params)} RETURNING *`, params)
      return r.rows
    }

    // delete
    const r = await this.db.pg.query<Row>(`DELETE FROM ${t}${this.where(params)} RETURNING *`, params)
    return r.rows
  }
}

// --- storage ----------------------------------------------------------------

/**
 * Supabase Storage, but a folder. `createSignedUploadUrl` hands the browser a
 * path on the local server instead of a signed S3 URL; the recorder checks
 * for that and PUTs the bytes there. `download` reads the file back.
 */
class LocalBucket {
  constructor(private root: string, private name: string) {}

  private path(key: string) {
    const p = resolve(this.root, this.name, key)
    if (!p.startsWith(resolve(this.root, this.name))) throw new Error('bad key')
    return p
  }
  async createSignedUploadUrl(key: string) {
    return {
      data: { token: 'local', path: key, signedUrl: `/api/local/upload/${this.name}/${key}`, local: true },
      error: null,
    }
  }
  async download(key: string) {
    const p = this.path(key)
    if (!existsSync(p)) return { data: null, error: { message: `no such object: ${key}` } }
    return { data: new Blob([readFileSync(p)]), error: null }
  }
  async upload(key: string, body: Uint8Array | ArrayBuffer | Buffer) {
    const p = this.path(key)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, body instanceof ArrayBuffer ? new Uint8Array(body) : body)
    return { data: { path: key }, error: null }
  }
  async remove(keys: string[]) {
    for (const k of keys) {
      const p = this.path(k)
      if (existsSync(p)) unlinkSync(p)
    }
    return { data: keys.map((k) => ({ name: k })), error: null }
  }
  /** Local only: where a key lives on disk, for the upload route. */
  file(key: string) { return this.path(key) }
}

// --- the client -------------------------------------------------------------

export class LocalDb {
  schema = new Schema()
  storage = {
    from: (bucket: string) => new LocalBucket(join(this.dir, 'storage'), bucket),
  }
  auth = {
    getUser: async (_token?: string) => ({ data: { user: { ...LOCAL_USER, user_metadata: { name: LOCAL_USER.name } } }, error: null }),
  }

  private constructor(public pg: PGlite, public dir: string) {}

  static async open(dir: string, schemaSql: string) {
    mkdirSync(dir, { recursive: true })
    // pgvector, so a workspace on this Mac can be asked questions too.
    const pg = new PGlite(join(dir, 'db'), { extensions: { vector } })
    await pg.waitReady
    // pgcrypto is not loadable here and is only in the schema for
    // gen_random_uuid(), which has been core Postgres since 13.
    await pg.exec(schemaSql.replace(/create extension if not exists "pgcrypto";/i, ''))
    const db = new LocalDb(pg, dir)
    await db.schema.load(pg)
    return db
  }

  from(table: string) { return new Query(this, table) }

  /**
   * A database function, called the way supabase-js calls one. Alfredo uses
   * it for the search that asks the workspace something (alfredo_search).
   */
  async rpc<T = Row[]>(name: string, args: Record<string, unknown> = {}): Promise<Result<T>> {
    const keys = Object.keys(args)
    const call = keys.length ? keys.map((k, i) => `"${k}" => $${i + 1}`).join(', ') : ''
    try {
      const r = await this.pg.query<Row>(`SELECT * FROM "${name}"(${call})`, keys.map((k) => args[k] as never))
      return { data: r.rows as T, error: null }
    } catch (e) {
      return { data: [] as unknown as T, error: { message: (e as Error).message } }
    }
  }

  /** Values that need help crossing into Postgres: JSON for jsonb columns. */
  encode(table: string, col: string, v: unknown) {
    const type = this.schema.types.get(table)?.get(col)
    if (type === 'jsonb' || type === 'json') return v === undefined ? null : JSON.stringify(v)
    return v === undefined ? null : v
  }

  /** Values on the way out: Supabase sends strings where PGlite sends Dates. */
  private decode(table: string, row: Row) {
    const types = this.schema.types.get(table)
    const out: Row = {}
    for (const [k, v] of Object.entries(row)) {
      const t = types?.get(k)
      if (v instanceof Date) out[k] = t === 'date' ? v.toISOString().slice(0, 10) : v.toISOString()
      else out[k] = v
    }
    return out
  }

  /** Attach embedded relations, the way PostgREST's `rel(cols)` does. */
  async embed(table: string, rows: Row[], sel: { cols: string[]; embeds: Embed[] }): Promise<Row[]> {
    const decoded = rows.map((r) => this.decode(table, r))
    if (!sel.embeds.length) return decoded.map((r) => this.project(r, sel.cols))

    for (const e of sel.embeds) {
      const rel = this.schema.relation(table, e.name)
      if (!rel) throw new Error(`local-db: no relation from ${table} to ${e.name}`)

      if (rel.dir === 'forward') {
        const ids = [...new Set(decoded.map((r) => r[rel.col]).filter((v) => v != null))]
        const related = ids.length
          ? (await this.pg.query<Row>(`SELECT * FROM "${e.name}" WHERE "${rel.refCol}" = ANY($1)`, [ids])).rows
          : []
        const shaped = await this.embed(e.name, related, { cols: e.cols, embeds: e.embeds })
        const byId = new Map(related.map((r, i) => [String(r[rel.refCol]), shaped[i]]))
        for (const r of decoded) r[e.name] = r[rel.col] == null ? null : (byId.get(String(r[rel.col])) ?? null)
      } else {
        const ids = decoded.map((r) => r[rel.refCol]).filter((v) => v != null)
        const related = ids.length
          ? (await this.pg.query<Row>(`SELECT * FROM "${e.name}" WHERE "${rel.col}" = ANY($1)`, [ids])).rows
          : []
        const shaped = await this.embed(e.name, related, { cols: e.cols, embeds: e.embeds })
        const groups = new Map<string, Row[]>()
        related.forEach((r, i) => {
          const k = String(r[rel.col])
          groups.set(k, [...(groups.get(k) ?? []), shaped[i]])
        })
        for (const r of decoded) {
          const g = groups.get(String(r[rel.refCol])) ?? []
          r[e.name] = rel.one ? (g[0] ?? null) : g
        }
      }
    }
    return decoded.map((r) => this.project(r, sel.cols, sel.embeds.map((e) => e.name)))
  }

  private project(row: Row, cols: string[], keep: string[] = []) {
    if (cols.includes('*')) return row
    const out: Row = {}
    for (const c of cols) if (c in row) out[c] = row[c]
    for (const k of keep) out[k] = row[k]
    return out
  }

  async close() { await this.pg.close() }
}
