// Applies db/schema.sql, then db/policies.sql, to the Supabase project in
// .env.local. The policies are what let a teammate connect with the
// publishable key and their own sign-in and still only see their projects.
// Uses node-postgres rather than psql so there is nothing to brew install.
import { readFileSync } from 'node:fs'
import pg from 'pg'

const url = process.env.SUPABASE_POOL_URL ?? process.env.SUPABASE_DB_URL
if (!url) {
  console.error(
    'SUPABASE_DB_URL is not set in .env.local.\n' +
      'Dashboard > Project Settings > Database > Connection string > URI.\n' +
      'Percent-encode special characters in the password (! becomes %21).',
  )
  process.exit(1)
}

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
await client.connect()
try {
  // The schema is idempotent, so a re-run is safe; one transaction so a
  // failure halfway does not leave the board half-built.
  await client.query('begin')
  await client.query(readFileSync('db/schema.sql', 'utf8'))
  await client.query(readFileSync('db/policies.sql', 'utf8'))
  await client.query('commit')
  const { rows } = await client.query(
    `select table_name from information_schema.tables
     where table_schema = 'public' order by table_name`,
  )
  const { rows: pol } = await client.query(`select count(*)::int as n from pg_policies where schemaname = 'public'`)
  console.log('schema applied. tables:', rows.map((r) => r.table_name).join(', '))
  console.log('policies:', pol[0].n)
} catch (e) {
  await client.query('rollback').catch(() => {})
  console.error('failed:', e.message)
  process.exitCode = 1
} finally {
  await client.end()
}
