// Composio, through its own CLI. The CLI is the supported surface and it
// already holds the login, so Alfredo drives it rather than talking to the
// API directly. It only prints for a terminal, hence the pseudo-terminal.
//
// Per workspace: each app can point at a different connected account by
// alias (the work Gmail, a side project's Gmail). Sessions get that map in their
// environment and pass --account when they run tools.

import { pty } from './pty-load'
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

/**
 * What went wrong, in words, out of a screenful of drawn box.
 *
 * The CLI is talking to a person at a terminal: spinners, rules, and a frame
 * down the left of every line. Passed along as it stands, its last two lines
 * are a pipe and a rule, and that is what the app showed — a bar at the bottom
 * of the screen with a line running off the side of it, saying nothing. The
 * CLI does mark its trouble, with a square before the sentence that says it,
 * so that sentence is the one to take, and failing that the last line with
 * words in it.
 */
const FRAME = /^[\s\u2502\u2503|]*[\u25c7\u25c6\u25d2\u25d0\u25d1\u25d3\u25a0\u25a1\u25b2\u25bc\u25b8\u25aa\u00b7.\u2026]*\s*/
const OUTLINE = /^[\s\u2500-\u257f|_\-=.\u2026\u25a0-\u25ff]*$/

export function whatWentWrong(out: string, fallback: string): string {
  const said = strip(out)
    .split('\n')
    .map((line) => line.replace(/[\s\u2502]+$/, ''))
    /* A line of frame, rule or spinner has nothing in it to read. */
    .filter((line) => line.trim() && !OUTLINE.test(line) && /[A-Za-z]{3}/.test(line))
  const marked = said.find((line) => /^[\s\u2502]*\u25a0/.test(line))
  const one = (marked ?? said[said.length - 1] ?? '').replace(FRAME, '').trim()
  return one.slice(0, 300) || fallback
}

/** Run a composio command in a pseudo-terminal and return what it printed. */
/**
 * Where the CLI is, and the PATH a terminal would give it. Found once through a
 * login shell (the only thing that knows the person's PATH), then every run
 * starts the binary itself: a login shell reads the whole profile each time,
 * which was most of the wait on every Composio call.
 */
let found: Promise<{ bin: string | null; path: string }> | null = null
function whereIsComposio() {
  if (found) return found
  found = new Promise((resolve, reject) => {
    let p: ReturnType<ReturnType<typeof pty>['spawn']>
    try {
      p = pty().spawn(SHELL, ['-lic', 'command -v composio; echo "PATH=$PATH"'], { name: 'xterm-256color', cols: 200, rows: 10, cwd: homedir(), env: { ...process.env, TERM: 'xterm-256color' } })
    } catch (e) {
      found = null
      return reject(e)
    }
    let out = ''
    p.onData((d) => (out += d))
    const t = setTimeout(() => {
      try {
        p.kill()
      } catch {}
    }, 15_000)
    p.onExit(() => {
      clearTimeout(t)
      const text = strip(out)
      const bin = text.split('\n').map((l) => l.trim()).find((l) => /^\/.*composio$/.test(l)) ?? null
      const path = /PATH=([^\r\n]+)/.exec(text)?.[1] ?? process.env.PATH ?? ''
      resolve({ bin, path })
    })
  })
  return found
}

export function runComposio(args: string[], timeoutMs = 20_000): Promise<{ out: string; code: number }> {
  return new Promise(async (resolve) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|AI_AGENT)/.test(k)))
    let where: { bin: string | null; path: string }
    try {
      where = await whereIsComposio()
    } catch (e) {
      return resolve({ out: (e as Error).message, code: 1 })
    }
    const p = where.bin
      ? pty().spawn(where.bin, args, { name: 'xterm-256color', cols: 160, rows: 40, cwd: homedir(), env: { ...env, PATH: where.path, TERM: 'xterm-256color', NO_COLOR: '1' } })
      : pty().spawn(SHELL, ['-lic', `composio ${args.map(q).join(' ')}`], {
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

export type Account = { id: string; alias: string; status: string; email?: string; createdAt?: string }

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
  const list: Account[] = rows.map((r) => ({
    id: String(r.id ?? r.connected_account_id ?? ''),
    alias: String(r.alias ?? r.word_id ?? r.name ?? ''),
    status: String(r.status ?? 'ACTIVE').toUpperCase(),
    email: r.email ?? r.user_email ?? r.metadata?.email ?? known()[String(r.id ?? '')] ?? undefined,
    createdAt: r.created_at ?? undefined,
  }))
  for (const account of list) if (!account.email) learnWho(toolkit, account)
  return list
}

// --- who an account is ---------------------------------------------------------
//
// The CLI lists an account by an alias somebody typed or two words it made up,
// and "carex-basket" does not say whether that is the work calendar or your
// own. The app it belongs to can say, so it is asked once, with a call that
// only reads, and the answer is kept: an account's address does not change.

const WHO_FILE = join(appHome(), 'cache', 'composio-who.json')
/** The read that names the account, per app. Apps not here keep their alias. */
const WHO: Record<string, { tool: string; args: Record<string, unknown> }> = {
  googlecalendar: { tool: 'GOOGLECALENDAR_GET_CALENDAR', args: { calendar_id: 'primary' } },
  gmail: { tool: 'GMAIL_GET_PROFILE', args: { user_id: 'me' } },
}
let who: Record<string, string> | null = null
const known = (): Record<string, string> => {
  if (!who) {
    try {
      who = JSON.parse(readFileSync(WHO_FILE, 'utf8')) as Record<string, string>
    } catch {
      who = {}
    }
  }
  return who
}
const asking = new Set<string>()

/** Find out whose account this is, behind the screen. Never awaited by a page. */
function learnWho(toolkit: string, account: Account) {
  const how = WHO[toolkit]
  if (!how || !account.id || known()[account.id] || asking.has(account.id) || account.status !== 'ACTIVE') return
  asking.add(account.id)
  runComposio(['execute', how.tool, '-d', JSON.stringify(how.args), '--account', account.alias || account.id], 30_000)
    .then(({ out }) => {
      const email = /"(?:id|summary|emailAddress|email)"\s*:\s*"([^"\s]+@[^"\s]+)"/.exec(out)?.[1]
      if (!email) return
      known()[account.id] = email
      try {
        mkdirSync(dirname(WHO_FILE), { recursive: true })
        writeFileSync(WHO_FILE, JSON.stringify(known()))
      } catch {}
      /* The panel's kept answer learns it too, so the next draw has the name. */
      for (const row of memo?.accounts?.[toolkit] ?? []) if (row.id === account.id) row.email = email
      if (memo) toDisk(memo)
    })
    .catch(() => {})
    .finally(() => asking.delete(account.id))
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
/** Called once at boot: have the answer ready before anyone opens the panel. */
export function warm() {
  if (!installed()) return
  setTimeout(() => void snapshot().catch(() => {}), 3000)
}

export async function snapshot(force = false): Promise<Snapshot> {
  const have = memo ?? fromDisk()
  if (have) memo = have
  const stale = !have || Date.now() - have.at > FRESH_MS || force
  if (!stale) return have!
  if (!running) running = look().finally(() => (running = null))
  return have ? { ...have, checking: true } : { status: { installed: installed(), loggedIn: installed(), email: '' }, accounts: {}, at: 0, checking: true }
}

/** Whose account an alias is, as far as is known: for saying which calendar a
 *  meeting is on in words a person recognises. Never waits on the CLI. */
export function whoIs(toolkit: string, alias: string): string | null {
  const rows = (memo ?? fromDisk())?.accounts?.[toolkit] ?? []
  const row = rows.find((a) => a.alias === alias || a.id === alias)
  return row?.email ?? (row ? known()[row.id] : undefined) ?? null
}

/** After linking or unlinking, the next look should be a real one. */
export function invalidate() {
  memo = null
  try {
    writeFileSync(FILE, JSON.stringify({ status: { installed: true, loggedIn: true, email: '' }, accounts: {}, at: 0, checking: false }))
  } catch {}
}

/** Start an OAuth link: the URL to open, and the account id to watch for. */
export async function linkUrl(toolkit: string, wanted?: string) {
  const args = ['link', toolkit, '--no-browser', '--no-wait']
  /* An alias names one account. A workspace's second calendar asked for under
     the first one's name is refused, or worse, takes its place: so the name is
     the workspace's, then the workspace's with a 2, a 3. */
  let alias = wanted
  if (alias) {
    const taken = new Set((await accounts(toolkit).catch(() => [] as Account[])).map((a) => a.alias))
    for (let n = 2; taken.has(alias) || taken.has(`${toolkit}_${alias}`); n++) alias = `${wanted}-${n}`
    args.push('--alias', alias)
  }
  const { out } = await runComposio(args, 30_000)
  const d = lastJson(out)
  const url = d?.redirect_url ?? /https?:\/\/\S+/.exec(out)?.[0]?.replace(/[)\].,│]+$/, '') ?? ''
  if (!url) throw new Error(whatWentWrong(out, 'Composio did not hand back a link. Run composio login in a terminal and try again.'))
  return { url, accountId: String(d?.connected_account_id ?? d?.id ?? ''), alias: alias ?? '' }
}
