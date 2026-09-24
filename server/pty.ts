// Terminal sessions, living on the local server rather than in the tab.
//
// This is the half a browser cannot do for itself: a page has no shell. The
// Node server on your Mac owns the pseudo-terminals, so a session outlives the
// tab that started it. Close the browser, come back, and Claude is still where
// you left it -- which is the whole reason to run agents from a harness instead
// of a pile of terminal windows you are afraid to close.
//
// Local only. server/edge.ts never imports this: there is no shell at the edge,
// and exposing one over the public API would be handing out the machine.

import type { IPty } from 'node-pty'
import { pty as loadPty } from './pty-load'
import xtermHeadless from '@xterm/headless'
const { Terminal } = xtermHeadless as unknown as { Terminal: typeof import('@xterm/headless').Terminal }
import { homedir } from 'node:os'
import { readdirSync, existsSync, statSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type SessionMeta = {
  id: string
  title: string
  cwd: string
  /** What was launched: a bare shell, or an agent we know how to start. */
  kind: 'shell' | 'claude' | 'codex' | 'gemini'
  createdAt: number
  /** Set when the process ends, so the UI can show it without losing scrollback. */
  exitedAt: number | null
  /** The workspace this session was started from; the rail groups by it. */
  workspace: string | null
  /** The card it is working on (its ref), when one handed the work over. */
  card: string | null
  /** When output last arrived. Recent output means the agent is working;
   *  a quiet session is waiting on you. */
  lastOutputAt: number
  /** Git branch of the folder, for the chip under the composer. */
  branch: string
  /** Claude Code's live status line while it works: the verb it picked,
   *  elapsed time, tokens, thinking effort. Cleared when it stops. */
  status: string
  /** The permission mode Claude Code last printed in its status line
   *  ("accept edits on"…). Empty means default, or not seen yet. */
  modeHint: string
  /** Claude Code has drawn its prompt at least once: input will land. */
  ready: boolean
  /** The spinner line Claude Code shows while it works: what it is doing and
   *  for how long. The closest thing to its thoughts that it writes anywhere. */
  termStatus: string
  /** The Claude Code conversation id, when this is a claude session. Its
   *  transcript on disk is what the chat view renders. */
  claudeId: string | null
  /** The title the program set on the terminal. Claude Code puts a spinner
   *  glyph in front while it works and ✳ when it is waiting, which is a far
   *  better "busy" signal than watching for output. */
  termTitle: string
}

type Session = SessionMeta & {
  pty: IPty
  /**
   * Recent output, replayed when a tab attaches. A terminal with no history is
   * useless on reconnect: you would be staring at a blank screen while a live
   * agent works. Capped so a chatty build cannot grow without bound.
   */
  scrollback: string[]
  bytes: number
  listeners: Set<(chunk: string) => void>
  cols: number
  rows: number
}

const SCROLLBACK_BYTES = 512 * 1024
const sessions = new Map<string, Session>()

const SHELL = process.env.SHELL || '/bin/zsh'

/** Single-quote for a shell, the only form that needs no other escaping. */
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/** Login shell, so PATH matches the terminal the person actually uses. */
function launchArgs(kind: SessionMeta['kind'], seed?: string, resume?: string, fresh?: string) {
  if (kind === 'shell') return { file: SHELL, args: ['-l'] as string[] }
  // Picking up a Claude Code conversation where it left off.
  if (kind === 'claude' && resume) return { file: SHELL, args: ['-lic', `claude --resume ${q(resume)}`] as string[] }
  // A new one gets an id we chose, so its transcript can be found on disk.
  if (kind === 'claude' && fresh) {
    const cmd = `claude --session-id ${q(fresh)}${seed ? ` ${q(seed)}` : ''}`
    return { file: SHELL, args: ['-lic', cmd] as string[] }
  }
  // Run the agent *through* a login shell so nvm/homebrew PATH setup applies
  // and the agent is found the same way it would be by hand.
  //
  // A seeded prompt goes in as the CLI's positional argument rather than being
  // typed into the terminal after launch. Typing races the agent's own startup
  // -- on a folder it has not seen before, Claude asks whether the directory is
  // trusted, and anything sent while that prompt is up is eaten by it.
  const cmd = seed ? `${kind} ${q(seed)}` : kind
  return { file: SHELL, args: ['-lic', cmd] as string[] }
}

/**
 * Claude Code asks whether to trust a folder the first time it opens it, and
 * the answer is kept in ~/.claude.json. Choosing the folder in Alfredo is that
 * answer, so it is written ahead of the launch: the first message would
 * otherwise vanish into that prompt.
 */
function trustFolder(cwd: string) {
  try {
    const file = join(homedir(), '.claude.json')
    const cfg = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
    cfg.projects ??= {}
    const p = (cfg.projects[cwd] ??= {})
    if (p.hasTrustDialogAccepted && p.hasCompletedProjectOnboarding) return
    p.hasTrustDialogAccepted = true
    p.hasCompletedProjectOnboarding = true
    writeFileSync(file, JSON.stringify(cfg, null, 2))
  } catch {
    /* Claude Code will just ask, as before */
  }
}

export function open(opts: {
  cwd: string
  kind?: SessionMeta['kind']
  title?: string
  /** An opening prompt, e.g. the card this session is meant to work on. */
  seed?: string
  /** A Claude Code session id to resume instead of starting fresh. */
  resume?: string
  workspace?: string | null
  card?: string | null
  /** Extra environment for the process, e.g. which Composio accounts to use. */
  extraEnv?: Record<string, string>
  /** Make the folder if it does not exist (a workspace's own chat folder). */
  create?: boolean
  cols?: number
  rows?: number
}) {
  const kind = opts.kind ?? 'shell'
  if (opts.create && !existsSync(opts.cwd)) {
    try {
      mkdirSync(opts.cwd, { recursive: true })
    } catch {}
  }
  const cwd = existsSync(opts.cwd) ? opts.cwd : homedir()
  const claudeId = kind === 'claude' ? (opts.resume ?? crypto.randomUUID()) : null
  if (kind === 'claude') trustFolder(cwd)
  const { file, args } = launchArgs(kind, opts.seed, opts.resume, opts.resume ? undefined : (claudeId ?? undefined))

  // A server started from inside a Claude Code session inherits its
  // CLAUDECODE markers, and a claude launched with those thinks it is nested:
  // it stops saving transcripts and hides itself from --resume. Sessions
  // here are top-level, so those never pass through.
  const parentEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^(CLAUDE|AI_AGENT)/.test(k)),
  )
  const pty = loadPty().spawn(file, args, {
    name: 'xterm-256color',
    cols: opts.cols ?? 120,
    rows: opts.rows ?? 32,
    cwd,
    env: {
      ...parentEnv,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      // So the agent's MCP connection lands on this workspace's board, not
      // whichever one happens to be active in the app.
      ALFRED_WORKSPACE: opts.workspace ?? '',
      ALFRED_CARD: opts.card ?? '',
      ...(opts.extraEnv ?? {}),
    },
  })

  const s: Session = {
    id: crypto.randomUUID(),
    title: opts.title || `${kind === 'shell' ? 'Shell' : kind} · ${cwd.split('/').pop()}`,
    cwd,
    kind,
    createdAt: Date.now(),
    exitedAt: null,
    workspace: opts.workspace ?? null,
    card: opts.card ?? null,
    lastOutputAt: Date.now(),
    claudeId,
    branch: branchOf(cwd),
    termTitle: '',
    modeHint: '',
    ready: kind !== 'claude',
    status: '',
    termStatus: '',
    pty,
    scrollback: [],
    bytes: 0,
    listeners: new Set(),
    cols: opts.cols ?? 120,
    rows: opts.rows ?? 32,
  }

  const TITLE = /\x1b\]0;([^\x07\x1b]*)(?:\x07|\x1b\\)/g
  const MODE = /(accept edits|plan mode|auto mode|bypass permissions) on/
  let tail = ''
  pty.onData((chunk) => {
    s.lastOutputAt = Date.now()
    let m: RegExpExecArray | null
    while ((m = TITLE.exec(chunk))) s.termTitle = m[1]
    const plain = chunk.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    // The input prompt or a status line means Claude Code is up and listening.
    if (!s.ready && /❯|to cycle\)/.test(plain)) s.ready = true
    const mode = MODE.exec(plain)
    if (mode) s.modeHint = { 'accept edits': 'acceptEdits', 'plan mode': 'plan', 'auto mode': 'auto', 'bypass permissions': 'bypassPermissions' }[mode[1]] ?? ''
    // "✻ Actioning… (15s · ↓ 2.1k tokens · thinking)" — keep the latest one.
    // The TUI paints in pieces, so match against a rolling tail, not one chunk.
    tail = (tail + plain).slice(-4000)
    const found = [...tail.matchAll(/[✻✶✳✢·⏺✽✺⋆*]\s*([A-Z][\w' ]{2,30}…[^\n\r]{0,80})/g)]
    if (found.length) s.termStatus = s.status = found[found.length - 1][1].replace(/\s+/g, ' ').trim()
    s.scrollback.push(chunk)
    s.bytes += chunk.length
    while (s.bytes > SCROLLBACK_BYTES && s.scrollback.length > 1) {
      s.bytes -= s.scrollback.shift()!.length
    }
    for (const send of s.listeners) send(chunk)
  })

  pty.onExit(({ exitCode }) => {
    s.exitedAt = Date.now()
    for (const send of s.listeners) send(`\r\n\x1b[2m[session ended (${exitCode})]\x1b[0m\r\n`)
  })

  sessions.set(s.id, s)
  return meta(s)
}

const meta = (s: Session): SessionMeta => ({
  id: s.id,
  title: s.title,
  cwd: s.cwd,
  kind: s.kind,
  createdAt: s.createdAt,
  exitedAt: s.exitedAt,
  workspace: s.workspace,
  card: s.card,
  lastOutputAt: s.lastOutputAt,
  claudeId: s.claudeId,
  termTitle: s.termTitle,
  modeHint: s.modeHint,
  ready: s.ready,
  status: /^✳/.test(s.termTitle) ? '' : s.status,
  termStatus: /^✳/.test(s.termTitle) ? '' : s.termStatus,
  branch: (s.branch = branchOf(s.cwd)),
})

/** Resolve once the session can take input, or after `ms` regardless. */
export function whenReady(id: string, ms = 20_000) {
  return new Promise<boolean>((resolve) => {
    const s = sessions.get(id)
    if (!s || s.ready || s.exitedAt) return resolve(!!s?.ready)
    const start = Date.now()
    const t = setInterval(() => {
      const cur = sessions.get(id)
      if (!cur || cur.ready || cur.exitedAt || Date.now() - start > ms) {
        clearInterval(t)
        resolve(!!cur?.ready)
      }
    }, 150)
  })
}

/** A new prompt went in; the old status line is history. */
export function clearStatus(id: string) {
  const s = sessions.get(id)
  if (s) s.status = s.termStatus = ''
}

/**
 * What the terminal is showing right now, as plain lines. The scrollback is
 * replayed through a headless terminal so cursor movement and redraws
 * resolve the way they do on screen, which is what makes a full-screen panel
 * like /usage readable as text.
 */
export async function screen(id: string): Promise<string[]> {
  const s = sessions.get(id)
  if (!s) return []
  const term = new Terminal({ cols: s.cols, rows: s.rows, scrollback: 400, allowProposedApi: true })
  await new Promise<void>((resolve) => term.write(s.scrollback.join(''), resolve))
  const buf = term.buffer.active
  const lines: string[] = []
  for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '')
  term.dispose()
  // Trailing blank lines are just unused rows.
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
  return lines
}

/** Forget the last-seen mode, e.g. right before pressing Shift+Tab. */
export function clearModeHint(id: string) {
  const s = sessions.get(id)
  if (s) s.modeHint = ''
}

/** The checked-out branch, read straight from .git so it costs nothing. */
function branchOf(cwd: string): string {
  try {
    let dir = cwd
    for (let i = 0; i < 6; i++) {
      const head = join(dir, '.git', 'HEAD')
      if (existsSync(head)) {
        const t = readFileSync(head, 'utf8').trim()
        return t.startsWith('ref: ') ? t.slice(5).replace(/^refs\/heads\//, '') : t.slice(0, 7)
      }
      const up = join(dir, '..')
      if (up === dir) break
      dir = up
    }
  } catch {}
  return ''
}

export const list = () =>
  [...sessions.values()].sort((a, b) => a.createdAt - b.createdAt).map(meta)

export function attach(id: string, send: (chunk: string) => void) {
  const s = sessions.get(id)
  if (!s) return null
  // Replay first, so the tab opens on the conversation already in progress.
  send(s.scrollback.join(''))
  s.listeners.add(send)
  return () => s.listeners.delete(send)
}

export function write(id: string, data: string) {
  const s = sessions.get(id)
  if (s && !s.exitedAt) s.pty.write(data)
}

export function resize(id: string, cols: number, rows: number) {
  const s = sessions.get(id)
  if (s && !s.exitedAt) {
    try {
      s.cols = Math.max(2, cols)
      s.rows = Math.max(2, rows)
      s.pty.resize(Math.max(2, cols), Math.max(2, rows))
    } catch {
      // A resize racing the process exiting is not worth taking the server down.
    }
  }
}

export function close(id: string) {
  const s = sessions.get(id)
  if (!s) return false
  try {
    if (!s.exitedAt) s.pty.kill()
  } catch {
    /* already gone */
  }
  sessions.delete(id)
  return true
}

export function rename(id: string, patch: { title?: string; workspace?: string | null; card?: string | null }) {
  const s = sessions.get(id)
  if (!s) return null
  if (patch.title?.trim()) s.title = patch.title.trim()
  if (patch.workspace !== undefined) s.workspace = patch.workspace
  if (patch.card !== undefined) s.card = patch.card
  return meta(s)
}

/**
 * Git repositories under the home directory, one level down. This is the list
 * of things worth opening a session in, and it is discovered rather than
 * configured so a new clone shows up without anyone maintaining a list.
 */
export function projects() {
  const home = homedir()
  const out: { name: string; path: string }[] = []
  for (const name of readdirSync(home)) {
    if (name.startsWith('.')) continue
    const path = join(home, name)
    try {
      if (!statSync(path).isDirectory()) continue
      if (existsSync(join(path, '.git'))) out.push({ name, path })
    } catch {
      // Unreadable directory; not a project as far as we are concerned.
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** Kill everything on the way out rather than orphaning shells. */
export function shutdown() {
  for (const id of [...sessions.keys()]) close(id)
}
