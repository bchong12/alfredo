// Composio, through its own CLI. The CLI is the supported surface and it
// already holds the login, so Alfredo drives it rather than talking to the
// API directly. It only prints for a terminal, hence the pseudo-terminal.
//
// Per workspace: each app can point at a different connected account by
// alias (the work Gmail, a side project's Gmail). Sessions get that map in their
// environment and pass --account when they run tools.

import { spawn } from 'node-pty'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { appHome } from './home'

const SHELL = process.env.SHELL || '/bin/zsh'
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/** The apps worth a card in the panel. Slugs are Composio toolkit slugs. */
export const TOOLKITS: { slug: string; name: string; blurb: string }[] = [
  { slug: 'gmail', name: 'Gmail', blurb: 'Read, search, draft and send mail' },
  { slug: 'googlecalendar', name: 'Google Calendar', blurb: 'Events, free time, invites' },
  { slug: 'github', name: 'GitHub', blurb: 'Issues, pull requests, repos' },
  { slug: 'slack', name: 'Slack', blurb: 'Channels and messages' },
  { slug: 'notion', name: 'Notion', blurb: 'Pages and databases' },
  { slug: 'linear', name: 'Linear', blurb: 'Issues and projects' },
  { slug: 'canvas', name: 'Canvas', blurb: 'Courses and assignments' },
  { slug: 'googledrive', name: 'Google Drive', blurb: 'Files and folders' },
  { slug: 'googlemeet', name: 'Google Meet', blurb: 'Meeting links and spaces' },
  { slug: 'googledocs', name: 'Google Docs', blurb: 'Documents to import' },
  { slug: 'googlesheets', name: 'Google Sheets', blurb: 'Tables to read' },
]

const strip = (s: string) =>
  s
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\r/g, '')

/** Run a composio command in a pseudo-terminal and return what it printed. */
export function runComposio(args: string[], timeoutMs = 20_000): Promise<{ out: string; code: number }> {
  return new Promise((resolve) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|AI_AGENT)/.test(k)))
    const p = spawn(SHELL, ['-lic', `composio ${args.map(q).join(' ')}`], {
      name: 'xterm-256color',
      cols: 160,
      rows: 40,
      cwd: homedir(),
      env: { ...env, TERM: 'xterm-256color', NO_COLOR: '1' },
    })
    let out = ''
    p.onData((d) => (out += d))
    const t = setTimeout(() => {
      try {
        p.kill()
      } catch {}
    }, timeoutMs)
    p.onExit(({ exitCode }) => {
      clearTimeout(t)
      resolve({ out: strip(out), code: exitCode })
    })
  })
}

export function installed() {
  return ['/opt/homebrew/bin/composio', '/usr/local/bin/composio', join(homedir(), '.local/bin/composio'), join(homedir(), '.composio/bin/composio')].some(existsSync) ||
    !!process.env.PATH?.split(':').some((d) => existsSync(join(d, 'composio')))
}

/** Logged in, and as whom. The CLI keeps its key in ~/.composio. */
export async function status() {
  if (!installed()) return { installed: false, loggedIn: false, email: '' }
  try {
    const u = JSON.parse(readFileSync(join(homedir(), '.composio', 'user_data.json'), 'utf8')) as { api_key?: string | null }
    if (!u.api_key) return { installed: true, loggedIn: false, email: '' }
  } catch {
    return { installed: true, loggedIn: false, email: '' }
  }
  const { out } = await runComposio(['whoami'], 15_000)
  const email = /"email"\s*:\s*"([^"]+)"/.exec(out)?.[1] ?? /([\w.+-]+@[\w-]+\.[\w.]+)/.exec(out)?.[1] ?? ''
  return { installed: true, loggedIn: true, email }
}

export type Account = { id: string; alias: string; status: string; email?: string }

/** The CLI ends with a JSON block after its spinner lines; take the last one. */
function lastJson(out: string): any | null {
  const lines = out.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*[{[]/.test(lines[i])) {
      for (let j = i; j >= 0; j--) {
        if (!/^\s*[{[]/.test(lines[j])) continue
        try {
          return JSON.parse(lines.slice(j).join('\n'))
        } catch {
          /* keep looking further up */
        }
      }
    }
  }
  return null
}

/** Connected accounts for one app, as the CLI lists them. */
export async function accounts(toolkit: string): Promise<Account[]> {
  const { out } = await runComposio(['link', toolkit, '--list'])
  const d = lastJson(out)
  const rows: any[] = Array.isArray(d) ? d : d?.items ?? d?.connected_accounts ?? d?.accounts ?? []
  return rows.map((r) => ({
    id: String(r.id ?? r.connected_account_id ?? ''),
    alias: String(r.alias ?? r.word_id ?? r.name ?? ''),
    status: String(r.status ?? 'ACTIVE').toUpperCase(),
    email: r.email ?? r.user_email ?? r.metadata?.email ?? undefined,
  }))
}

// --- one answer for the whole panel -------------------------------------------
//
// Every card used to cost its own CLI run through a login shell, which is
// seconds each and made the page crawl. The panel asks once now: the answer
// is kept in memory and on disk, handed over at once, and refreshed behind
// the screen so the next visit is instant too.

export type Snapshot = {
  status: { installed: boolean; loggedIn: boolean; email: string }
  accounts: Record<string, Account[]>
  at: number
  checking: boolean
}

const FILE = join(appHome(), 'cache', 'composio.json')
const FRESH_MS = 5 * 60_000
let memo: Snapshot | null = null
let running: Promise<Snapshot> | null = null

function fromDisk(): Snapshot | null {
  try {
    return JSON.parse(readFileSync(FILE, 'utf8')) as Snapshot
  } catch {
    return null
  }
}

function toDisk(s: Snapshot) {
  try {
    mkdirSync(dirname(FILE), { recursive: true })
    writeFileSync(FILE, JSON.stringify(s))
  } catch {}
}

async function look(): Promise<Snapshot> {
  const st = await status()
  const byApp: Record<string, Account[]> = {}
  if (st.loggedIn) {
    // All at once: the CLI runs are independent and each one is a shell start.
    const pairs = await Promise.all(TOOLKITS.map(async (t) => [t.slug, await accounts(t.slug).catch(() => [] as Account[])] as const))
    for (const [slug, rows] of pairs) byApp[slug] = rows
  }
  const snap: Snapshot = { status: st, accounts: byApp, at: Date.now(), checking: false }
  memo = snap
  toDisk(snap)
  return snap
}

/**
 * What the panel draws. Nothing here ever waits on the CLI: a known answer
 * comes back at once, and a first visit gets an empty one that fills in.
 */
export async function snapshot(force = false): Promise<Snapshot> {
  const have = memo ?? fromDisk()
  if (have) memo = have
  const stale = !have || Date.now() - have.at > FRESH_MS || force
  if (!stale) return have!
  if (!running) running = look().finally(() => (running = null))
  return have ? { ...have, checking: true } : { status: { installed: installed(), loggedIn: installed(), email: '' }, accounts: {}, at: 0, checking: true }
}

/** After linking or unlinking, the next look should be a real one. */
export function invalidate() {
  memo = null
  try {
    writeFileSync(FILE, JSON.stringify({ status: { installed: true, loggedIn: true, email: '' }, accounts: {}, at: 0, checking: false }))
  } catch {}
}

/** Start an OAuth link: the URL to open, and the account id to watch for. */
export async function linkUrl(toolkit: string, alias?: string) {
  const args = ['link', toolkit, '--no-browser', '--no-wait']
  if (alias) args.push('--alias', alias)
  const { out } = await runComposio(args, 30_000)
  const d = lastJson(out)
  const url = d?.redirect_url ?? /https?:\/\/\S+/.exec(out)?.[0]?.replace(/[)\].,│]+$/, '') ?? ''
  if (!url) throw new Error(out.trim().split('\n').filter(Boolean).slice(-2).join(' ') || 'Composio did not return a link')
  return { url, accountId: String(d?.connected_account_id ?? '') }
}
