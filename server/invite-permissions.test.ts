import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { LocalDb } from './local-db'

test('invite execution removes direct anon grants while retaining authenticated invite checks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'alfredo-invite-acl-'))
  const db = await LocalDb.open(dir, readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'))
  const policies = readFileSync(new URL('../db/policies.sql', import.meta.url), 'utf8')
  const uid = '123e4567-e89b-42d3-a456-426614174123'
  try {
    await db.pg.exec(`
      create role anon; create role authenticated;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      create function auth.jwt() returns jsonb language sql stable as $$
        select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;
    `)
    await db.pg.exec(policies)
    // Existing explicit grants survive CREATE OR REPLACE and PUBLIC revocation.
    await db.pg.exec('grant execute on function alfredo_join(text,text) to anon')
    assert.equal((await db.pg.query<{ allowed: boolean }>("select has_function_privilege('anon','alfredo_join(text,text)','EXECUTE') allowed")).rows[0].allowed, true)
    await db.pg.exec(policies)
    await db.pg.exec(policies)
    assert.equal((await db.pg.query<{ allowed: boolean }>("select has_function_privilege('anon','alfredo_join(text,text)','EXECUTE') allowed")).rows[0].allowed, false)
    assert.equal((await db.pg.query<{ allowed: boolean }>("select has_function_privilege('authenticated','alfredo_join(text,text)','EXECUTE') allowed")).rows[0].allowed, true)
    await db.pg.exec('set role anon')
    try { await assert.rejects(db.pg.query("select alfredo_join('nonexistent')"), /permission denied/i) }
    finally { await db.pg.exec('reset role') }
    await db.pg.query("insert into invites(token_hash,email,role) values ('valid','invite@example.test','member'),('wrong-email','other@example.test','member')")
    await db.pg.query("select set_config('request.jwt.claim.sub',$1,false)", [uid])
    await db.pg.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ email: 'invite@example.test' })])
    await db.pg.exec('set role authenticated')
    try {
      await assert.rejects(db.pg.query("select alfredo_join('wrong-email')"), /different email/i)
      assert.equal((await db.pg.query<{ joined: { email: string } }>("select alfredo_join('valid') joined")).rows[0].joined.email, 'invite@example.test')
      await assert.rejects(db.pg.query("select alfredo_join('valid')"), /no longer good/i)
    } finally { await db.pg.exec('reset role') }
    assert.equal((await db.pg.query<{ n: number }>("select count(*)::int n from people where user_id=$1 and active and role='member'", [uid])).rows[0].n, 1)
  } finally {
    try { await db.pg.close() }
    finally { rmSync(dir, { recursive: true, force: true }) }
  }
})
