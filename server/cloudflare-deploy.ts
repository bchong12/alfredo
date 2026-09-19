// "Create on Cloudflare": put a new workspace database in your own
// Cloudflare account. Uses wrangler with your own login (`npx wrangler login`
// once), so Alfredo never holds a Cloudflare credential. Four steps:
//   1. a D1 database, alfredo-<name>
//   2. the tables (cloudflare/schema.sql)
//   3. the Worker (cloudflare/worker.mjs), the only door to that database
//   4. a fresh random ALFREDO_TOKEN secret, which also goes to this Mac's keychain
// Then it connects the workspace like any other Cloudflare one.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { appHome } from './home'
import { CloudflareWorkspace } from './cloudflare-workspace'

const TEMPLATE = fileURLToPath(new URL('../cloudflare/', import.meta.url))

export type DeployStep = 'check' | 'database' | 'tables' | 'worker' | 'token' | 'connect' | 'done' | 'failed'
export type Deploy = { step: DeployStep; log: string[]; error?: string; url?: string; name: string }

/** Where npx lives: the desktop app does not inherit your shell's PATH. */
function npx() {
  const nvm = join(homedir(), '.nvm/versions/node')
  const candidates = [
    '/opt/homebrew/bin/npx',
    '/usr/local/bin/npx',
    join(homedir(), '.npm-global/bin/npx'),
    ...(existsSync(nvm) ? [join(nvm, 'current/bin/npx')] : []),
  ]
  return candidates.find(existsSync) ?? 'npx'
}

function wrangler(args: string[], opts: { cwd?: string; input?: string; account?: string } = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const bin = npx()
    const dir = bin.includes('/') ? bin.slice(0, bin.lastIndexOf('/')) : ''
    const child = spawn(bin, ['--yes', 'wrangler@4', ...args], {
      cwd: opts.cwd,
      env: { ...process.env, PATH: [dir, '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH].filter(Boolean).join(':'), WRANGLER_SEND_METRICS: 'false',
        // Wrangler caches an account choice in the nearest node_modules/.cache, which
        // can name an account from an old login. Say which one explicitly.
        ...(opts.account ? { CLOUDFLARE_ACCOUNT_ID: opts.account } : {}),
      },
    })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    if (opts.input !== undefined) child.stdin.end(opts.input)
    else child.stdin.end()
    child.on('close', (code) => resolve({ code: code ?? 1, out }))
    child.on('error', (e) => resolve({ code: 1, out: String(e) }))
  })
}

// eslint-disable-next-line no-control-regex
const clean = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')

/** Is wrangler logged in here? Returns the account email, or null. */
export async function cloudflareLogin(): Promise<{ loggedIn: boolean; email: string | null; accounts: { id: string; name: string }[]; detail?: string }> {
  const r = await wrangler(['whoami'])
  const out = clean(r.out)
  const email = out.match(/associated with the email ([^\s.]+@[^\s]+?)\.?\s/)?.[1] ?? null
  const accounts = [...out.matchAll(/│\s*(.+?)\s*│\s*([0-9a-f]{32})\s*│/g)].map((m) => ({ name: m[1], id: m[2] }))
  if (r.code === 0 && /logged in/i.test(out)) return { loggedIn: true, email, accounts }
  return { loggedIn: false, email: null, accounts: [], detail: out.split('\n').find((l) => /not authenticated|log in|login/i.test(l))?.trim() }
}

const jobs = new Map<string, Deploy>()
export const deployJob = (id: string) => jobs.get(id) ?? null

export const workerName = (name: string) =>
  'alfredo-' + (name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'workspace')

/**
 * Start a deploy; poll deployJob(id) for progress. `connect` gets the Worker
 * URL and token at the end and registers the workspace.
 */
export function startDeploy(name: string, connect: (url: string, token: string) => Promise<unknown>): string {
  const id = randomBytes(6).toString('hex')
  const job: Deploy = { step: 'check', log: [], name }
  jobs.set(id, job)
  run(job, name, connect).catch((e) => {
    job.step = 'failed'
    job.error = (e as Error).message
  })
  return id
}

async function run(job: Deploy, name: string, connect: (url: string, token: string) => Promise<unknown>) {
  const say = (s: string) => job.log.push(s)
  let account: string | undefined
  const must = async (args: string[], what: string, opts: { cwd?: string; input?: string } = {}) => {
    const r = await wrangler(args, { ...opts, account })
    if (r.code !== 0) throw new Error(`${what} failed: ${clean(r.out).trim().split('\n').slice(-4).join(' ').slice(0, 400)}`)
    return clean(r.out)
  }

  const who = await cloudflareLogin()
  if (!who.loggedIn) throw new Error('Wrangler is not logged in on this Mac. Run `npx wrangler login` in a terminal, then try again.')
  // With several accounts, the first one wrangler lists (usually your own).
  account = who.accounts[0]?.id
  say(`Cloudflare account: ${who.accounts[0]?.name ?? who.email ?? 'signed in'}`)

  const worker = workerName(name)
  const dir = join(appHome(), 'cloudflare', worker)
  mkdirSync(dir, { recursive: true })
  copyFileSync(join(TEMPLATE, 'worker.mjs'), join(dir, 'worker.mjs'))
  copyFileSync(join(TEMPLATE, 'schema.sql'), join(dir, 'schema.sql'))

  job.step = 'database'
  const list = async () => {
    const out = await must(['d1', 'list', '--json'], 'Listing D1 databases', { cwd: dir })
    const start = out.indexOf('[')
    return JSON.parse(out.slice(start)) as { uuid: string; name: string }[]
  }
  let db = (await list()).find((d) => d.name === worker)
  if (db) say(`Using the existing database ${worker}`)
  else {
    await must(['d1', 'create', worker], 'Creating the D1 database', { cwd: dir })
    db = (await list()).find((d) => d.name === worker)
    if (!db) throw new Error('The database was created but did not show up in the list.')
    say(`Created database ${worker}`)
  }

  writeFileSync(
    join(dir, 'wrangler.jsonc'),
    JSON.stringify(
      {
        name: worker,
        main: 'worker.mjs',
        compatibility_date: '2026-09-01',
        workers_dev: true,
        d1_databases: [{ binding: 'DB', database_name: worker, database_id: db.uuid }],
      },
      null,
      2,
    ) + '\n',
  )

  job.step = 'tables'
  await must(['d1', 'execute', worker, '--remote', '--file', 'schema.sql', '--yes'], 'Creating the tables', { cwd: dir })
  say('Tables created')

  job.step = 'worker'
  const out = await must(['deploy'], 'Deploying the Worker', { cwd: dir })
  const url = out.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i)?.[0]
  if (!url) throw new Error('The Worker deployed, but wrangler did not print its URL. Is workers.dev enabled on your account?')
  say(`Worker live at ${url}`)

  job.step = 'token'
  const token = randomBytes(32).toString('hex')
  await must(['secret', 'put', 'ALFREDO_TOKEN'], 'Setting the token', { cwd: dir, input: token })
  say('Token set')

  job.step = 'connect'
  // A new workers.dev URL and a new secret take a while to reach every edge;
  // wait for several good answers in a row before trusting it.
  const probe = new CloudflareWorkspace(url, token)
  for (let good = 0, i = 0; good < 4 && i < 40; i++) {
    const ok = await probe.ping().then((p) => p.ok).catch(() => false)
    good = ok ? good + 1 : 0
    await new Promise((r) => setTimeout(r, ok ? 800 : 2500))
  }
  let last: Error | null = null
  for (let i = 0; i < 12; i++) {
    try {
      await connect(url, token)
      last = null
      break
    } catch (e) {
      last = e as Error
      await new Promise((r) => setTimeout(r, 2500))
    }
  }
  if (last) throw last
  job.url = url
  job.step = 'done'
  say('Connected')
}
