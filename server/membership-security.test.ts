import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { LocalDb } from './local-db'

test('realistic table grants cannot turn self-profile editing into membership administration', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'alfredo-membership-'))
  const db = await LocalDb.open(dir, readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'))
  const admin = '123e4567-e89b-42d3-a456-426614174001'
  const member = '123e4567-e89b-42d3-a456-426614174002'
  const viewer = '123e4567-e89b-42d3-a456-426614174003'
  const inactive = '123e4567-e89b-42d3-a456-426614174004'
  try {
    await db.pg.exec(`
      create role anon; create role authenticated;
      grant select, insert, update, delete on all tables in schema public to anon, authenticated;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      create function auth.jwt() returns jsonb language sql stable as $$
        select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;
    `)
    await db.pg.exec(readFileSync(new URL('../db/policies.sql', import.meta.url), 'utf8'))
    for (const [id, role, active] of [[admin, 'admin', true], [member, 'member', true], [viewer, 'viewer', true], [inactive, 'member', false]]) {
      await db.pg.query('insert into people (id,user_id,name,email,role,active) values ($1,$1,$2,$3,$4,$5)', [id, id, `${id}@example.test`, role, active])
    }
    const as = async (id: string | null, sql: string, values: unknown[] = []) => {
      await db.pg.query("select set_config('request.jwt.claim.sub',$1,false)", [id ?? ''])
      await db.pg.exec(`set role ${id ? 'authenticated' : 'anon'}`)
      try { return await db.pg.query(sql, values as never[]) } finally { await db.pg.exec('reset role') }
    }
    await db.pg.exec("insert into workspace_settings(key,value) values ('tabs','[]'::jsonb)")
    // Reproduce the previous exploit in this disposable database, then install
    // the shipped fix. No production row is used or changed by this test.
    await db.pg.exec(`drop trigger if exists people_protect_membership on people;
      drop policy people_self on people;
      create policy people_self on people for update using (user_id=auth.uid()) with check (user_id=auth.uid());`)
    assert.deepEqual((await as(member, "update people set role='admin' where id=$1 returning role", [member])).rows, [{ role: 'admin' }])
    await db.pg.query("update people set role='member' where id=$1", [member])
    await db.pg.exec(readFileSync(new URL('../db/policies.sql', import.meta.url), 'utf8'))
    for (const actor of [member, viewer]) {
      assert.equal((await as(actor, 'update people set name=$1,avatar_url=$2 where id=$3 returning id', [`Name ${actor}`, 'data:image/png;base64,AA', actor])).rows.length, 1)
      for (const change of ["role='admin'", "active=false", "email='admin@example.test'", `user_id='${admin}'`, `id='123e4567-e89b-42d3-a456-426614174099'`, 'position=999', "created_at='2000-01-01'"]) {
        await assert.rejects(as(actor, `update people set ${change} where id=$1`, [actor]))
      }
      assert.equal((await as(actor, 'update people set name=$1 where id=$2 returning id', ['Hijack', admin])).rows.length, 0)
      await assert.rejects(as(actor, "insert into people(name,role,user_id) values ('Injected','admin',$1)", [actor]))
      assert.equal((await as(actor, 'delete from people where id=$1 returning id', [actor])).rows.length, 0)
      assert.equal((await as(actor, "update workspace_settings set value='[1]'::jsonb where key='tabs' returning key")).rows.length, 0)
    }
    assert.equal((await as(inactive, "update people set name='Revived' where id=$1 returning id", [inactive])).rows.length, 0)
    assert.equal((await as(null, "update people set role='admin' returning id")).rows.length, 0)
    assert.equal((await as(admin, "update people set role='viewer' where id=$1 returning id", [member])).rows.length, 1)
    assert.deepEqual((await db.pg.query('select role from people where id=$1', [member])).rows, [{ role: 'viewer' }])
    // Trusted owner operations (including SECURITY DEFINER invite binding) remain possible.
    await db.pg.query("update people set role='member',active=true where id=$1", [member])
    assert.deepEqual((await db.pg.query('select role from people where id=$1', [admin])).rows, [{ role: 'admin' }])
    await db.pg.query("insert into invites(token_hash,email,role) values ('test-hash',$1,'member')", [`${inactive}@example.test`])
    await db.pg.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ email: `${inactive}@example.test` })])
    const joined = await as(inactive, "select alfredo_join('test-hash')")
    assert.equal(joined.rows.length, 1)
    assert.deepEqual((await db.pg.query('select active,role from people where id=$1', [inactive])).rows, [{ active: true, role: 'member' }])
  } finally { await db.pg.close(); rmSync(dir, { recursive: true, force: true }) }
})
