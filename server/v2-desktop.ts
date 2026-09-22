// The part of the v2 API that needs a machine to run on.
//
// v2.ts is the workspace as a database sees it: boards, docs, canvases,
// meetings, projects, people. It runs anywhere, the hosted site included. Some
// of what the desktop app does cannot: recording needs a microphone, reading a
// workspace in needs a model on this disk, the calendar comes through a CLI on
// this PATH, thumbnails and passages are cached in files here. All of that
// reaches v2.ts through the one door in v2-machine.ts, and this file is what
// the desktop app puts behind it.
import type { Hono } from 'hono'
import { unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appHome } from './home'
import { embedderState, readyEmbedder } from './embed'
import { shelfFor } from './chunk-shelf'
import { ask, findPassages, forget, indexProgress, keepReadIn, reindex, touch } from './knowledge'
import * as audio from './audio'
import { transcribe } from './ai-local'
import { summarize, hasLocalChat, teamContext, type Summary } from './ai'
import { parakeetAvailable } from './parakeet'
import { download as onnxDownload, downloadState as onnxState, downloaded as onnxReady } from './parakeet-onnx'
import { runComposio, whoIs } from './composio'
import { accountsFor, supabaseFor } from './workspaces'
import { CloudflareWorkspace } from './cloudflare-workspace'
import type { Hit, Store } from './v2'
import type { Machine, MachineRoutes } from './v2-machine'

const THUMBS = join(appHome(), 'cache', 'canvas-thumbs.json')

// --- transcription: transcript only, the audio never outlives it -------------

type Job = { id: string; title: string; project?: string | null; workspace?: string; state: 'recording' | 'transcribing' | 'writing' | 'done' | 'failed'; meetingId?: string; error?: string; startedAt: number; endedAt?: number }
const jobs = new Map<string, Job>()
let install: { state: 'idle' | 'running' | 'done' | 'failed'; log: string; startedAt?: number } = { state: 'idle', log: '' }

/** The write-up as Markdown notes: what the meeting page shows and edits. */
export function notesFrom(s: Summary): string {
  const out: string[] = ['## Summary', s.tldr]
  for (const sec of s.sections ?? []) out.push('', `## ${sec.heading}`, ...sec.bullets.map((b) => `- ${b}`))
  if (s.decisions?.length) out.push('', '## Decisions', ...s.decisions.map((d) => `- ${d.what}${d.why ? ` (${d.why})` : ''}`))
  if (s.action_items?.length)
    out.push('', '## Action items', ...s.action_items.map((a) => `- [ ] ${a.title}${a.assignee ? ` @${a.assignee}` : ''}${a.due ? ` (due ${a.due})` : ''}`))
  if (s.open_questions?.length) out.push('', '## Open questions', ...s.open_questions.map((q) => `- ${q.question}`))
  return out.join('\n')
}

async function finish(job: Job, st: Store, path: string, durationS: number, startedAt: number, workspace = '') {
  try {
    job.state = 'transcribing'
    const t = await transcribe(path)
    if (!t.text.trim()) throw new Error('No speech was heard. Check Microphone (and Screen Recording) access for Alfredo in System Settings.')
    job.state = 'writing'
    let notes = ''
    let title = job.title
    // What was said is the company's own words, so the write-up is written on
    // this Mac by Claude Code or not at all. Without it the transcript is still
    // the meeting; a note saying where the write-up went is enough.
    if (!hasLocalChat()) {
      notes = '_Transcribed on this Mac. The write-up is written by Claude Code, which is not installed here; install it (`claude` on your PATH) and the next meeting gets one. The transcript is below._'
    } else {
      try {
        const [set, people] = await Promise.all([st.settings(), st.members()]).catch(() => [null, []] as const)
        const s = await summarize('', t.text, undefined, undefined, teamContext(set?.name, people.map((p) => p.name)))
        notes = notesFrom(s)
        if ((!title || title === 'Meeting') && s.title?.trim()) title = s.title.trim()
      } catch (e) {
        notes = `_The write-up could not be generated: ${(e as Error).message}_`
      }
    }
    const m = await st.createMeeting({ title: title || 'Meeting', transcript: t.timed || t.text, notes, startedAt: new Date(startedAt).toISOString(), durationS: Math.round(durationS) })
    if (job.project) await st.assign('meeting', [m.id], job.project).catch(() => {})
    // Into the brain, the same as a meeting saved by hand: a transcript nobody
    // can find afterwards is half a meeting.
    touch(st, 'meeting', m.id, workspace)
    job.meetingId = m.id
    job.state = 'done'
  } catch (e) {
    job.state = 'failed'
    job.error = (e as Error).message
  } finally {
    job.endedAt = Date.now()
    // The audio exists only long enough to be transcribed.
    await unlink(path).catch(() => {})
  }
}

// --- the calendar: every account a workspace uses, as one list ----------------

type CalendarAnswer = { connected: boolean; accounts?: number; calendars: string[]; events: unknown[]; error: string | null }
const calendars = new Map<string, { at: number; answer: CalendarAnswer; aliases: string[] }>()
const looking = new Map<string, Promise<void>>()

/* What was found last is kept on disk, so the first look after the app opens
   is as quick as any other, and looked at again on a clock while the app is
   open, so nobody sits on "Checking your calendar": every account is a CLI
   run of a few seconds, and that can happen behind the page. */
const CALENDAR_FILE = join(appHome(), 'cache', 'calendar.json')
const CALENDAR_FRESH_MS = 3 * 60_000
try {
  if (existsSync(CALENDAR_FILE)) for (const [k, v] of Object.entries(JSON.parse(readFileSync(CALENDAR_FILE, 'utf8')) as Record<string, { at: number; answer: CalendarAnswer; aliases: string[] }>)) calendars.set(k, v)
} catch {}
function keepCalendars() {
  try {
    mkdirSync(dirname(CALENDAR_FILE), { recursive: true })
    writeFileSync(CALENDAR_FILE, JSON.stringify(Object.fromEntries(calendars)))
  } catch {}
}
function lookAgain(key: string, aliases: string[]) {
  if (looking.has(key)) return looking.get(key)!
  const look = lookAtCalendars(aliases)
    .then((answer) => {
      calendars.set(key, { at: Date.now(), answer, aliases })
      keepCalendars()
    })
    .catch(() => {})
    .finally(() => looking.delete(key))
  looking.set(key, look)
  return look
}
// Every calendar looked at in the last hour is looked at again before it goes stale.
setInterval(() => {
  for (const [key, kept] of calendars) {
    if (Date.now() - kept.at > CALENDAR_FRESH_MS - 20_000 && Date.now() - kept.at < 60 * 60_000) void lookAgain(key, kept.aliases)
  }
}, 30_000).unref()

async function lookAtCalendars(aliases: string[]): Promise<CalendarAnswer> {
  const ask = async (alias: string | null) => {
    const args = [
      'execute',
      'GOOGLECALENDAR_EVENTS_LIST',
      '-d',
      JSON.stringify({ calendarId: 'primary', timeMin: new Date().toISOString(), maxResults: 6, singleEvents: true, orderBy: 'startTime' }),
      ...(alias ? ['--account', alias] : []),
    ]
    const { out } = await runComposio(args, 30_000)
    const start = out.indexOf('{')
    let r: any = null
    try {
      r = start >= 0 ? JSON.parse(out.slice(start, out.lastIndexOf('}') + 1)) : null
    } catch {}
    if (!r?.successful) {
      const missing = /No active connection|link googlecalendar/i.test(r?.error ?? out)
      return { ok: false as const, missing, error: missing ? null : ((r?.error as string | undefined) ?? 'Calendar unavailable') }
    }
    const items: any[] = r.data?.items ?? r.data?.response_data?.items ?? []
    /* Whose calendar it is: the account's own address. Not the organiser's,
       which says who called the meeting and nothing about where it was found. */
    const calendar = alias ? (whoIs('googlecalendar', alias) ?? alias.replace(/^[a-z0-9]+_/, '')) : undefined
    return {
      ok: true as const,
      calendar,
      events: items.map((e: any) => ({
        id: e.id,
        title: e.summary ?? '(no title)',
        start: e.start?.dateTime ?? e.start?.date,
        end: e.end?.dateTime ?? e.end?.date,
        link: e.hangoutLink ?? e.location ?? null,
        people: (e.attendees ?? []).length,
        account: alias ?? undefined,
        calendar,
      })),
    }
  }
  const answers = await Promise.all((aliases.length ? aliases : [null]).map((alias) => ask(alias)))
  const good = answers.filter((a) => a.ok)
  if (!good.length) {
    const first = answers[0]
    return { connected: !(!first.ok && first.missing), calendars: [], events: [], error: !first.ok ? first.error : null }
  }
  /* The same meeting sits on both calendars when one invited the other. */
  const seen = new Set<string>()
  const events = good
    .flatMap((a) => (a.ok ? a.events : []))
    .sort((x, y) => String(x.start).localeCompare(String(y.start)))
    .filter((e) => {
      const key = `${e.title}|${e.start}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, 8)
  const failed = answers.find((a) => !a.ok && !a.missing)
  return {
    connected: true,
    accounts: aliases.length,
    calendars: good.flatMap((a) => (a.ok && a.calendar ? [a.calendar] : [])),
    events,
    error: failed && !failed.ok ? failed.error : null,
  }
}


function routes(app: Hono, { store, current, mine, projectOf, mapOf, NO_PROJECT }: MachineRoutes) {
  /**
   * The company brain. Everything written down, in a form a question can
   * reach, and an answer that says which piece of work it came from.
   */
  app.get('/brain', async (c) => {
    const st = store()
    const chunks = await st.chunkCount().catch(() => 0)
    /* Said on the Models page, so nobody wonders why a teammate's Mac knows nothing yet. */
    return c.json({ ...embedderState(), chunks, onThisMac: (st as { chunksOnThisMac?: boolean }).chunksOnThisMac === true, progress: indexProgress(current()?.workspace.id ?? '') })
  })
  app.post('/brain/read', async (c) => {
    const { me } = await mine(c)
    if (!me.admin) return c.json({ error: 'Only an admin can read the whole workspace in.' }, 403)
    return c.json(reindex(store(), current()?.workspace.id ?? ''))
  })
  app.post('/brain/model', async (c) => c.json(await readyEmbedder()))
  /**
   * An answer is about what is in front of you: inside a project, only that
   * project's work is weighed. The database refuses what you may not see
   * anyway; this keeps the answer honest for an admin, who may see it all.
   */
  const keepInView = async (c: any, hits: Hit[]) => {
    const p = projectOf(c)
    const [map, { me, allowed }, set] = await Promise.all([mapOf(store()), mine(c), store().settings()])
    const ok = new Set(allowed.map((x) => x.id))
    const unfiledIsMine = !set.projects?.enabled || me.admin
    return hits.filter((h) => {
      const inP = map[`${h.kind}:${h.itemId}`]
      if (p === NO_PROJECT) return !inP
      if (p) return inP === p
      return inP ? ok.has(inP) : unfiledIsMine
    })
  }

  app.post('/ask', async (c) => {
    const b = await c.req.json<{ question?: string; limit?: number }>()
    const question = (b.question ?? '').trim()
    if (!question) return c.json({ error: 'Ask something.' }, 400)
    const limit = Math.min(Math.max(Number(b.limit) || 14, 4), 30)
    return c.json(await ask(store(), question, limit, (hits) => keepInView(c, hits)))
  })
  app.post('/ask/passages', async (c) => {
    const b = await c.req.json<{ question?: string; limit?: number }>()
    const question = (b.question ?? '').trim()
    if (!question) return c.json([])
    const limit = Math.min(Math.max(Number(b.limit) || 10, 1), 30)
    return c.json(await keepInView(c, await findPassages(store(), question, limit)))
  })

  // Recording and Parakeet are the one part of Alfredo that needs a Mac: system
  // audio comes from ScreenCaptureKit and Parakeet runs on Apple silicon. The
  // app says so rather than offering a download that cannot work.
  /* Is a call going on? Asked by the app every few seconds so it can offer to
     record one that has started, and to stop when the one being recorded ends.
     A call is a window that says so (Meet, Zoom, Teams, FaceTime, a huddle),
     or, when nothing is being recorded here, the microphone open elsewhere. */
  app.get('/transcribe/call', async (c) => {
    const p = await audio.probe().catch(() => null)
    if (!p) return c.json({ inCall: false, app: null, screen: false, known: false })
    const named = p.calls[0]?.app ?? null
    const inCall = !!named || (p.micInUse && !audio.isRecording())
    return c.json({ inCall, app: named ?? (inCall ? 'A call' : null), screen: p.screen, known: !!named })
  })
  app.post('/transcribe/permissions/screen', async (c) => {
    const b = await c.req.json<{ reset?: boolean }>().catch(() => ({}) as { reset?: boolean })
    audio.askForScreen(!!b.reset)
    return c.json({ ok: true })
  })

  app.get('/transcribe/engine', async (c) => {
    const hears = await audio.hearing().catch(() => ({ can: false, both: false, why: '' }))
    return c.json({
      parakeet: parakeetAvailable(),
      recording: audio.isRecording(),
      install,
      // Whether this machine can record at all, and whether Parakeet could
      // transcribe it here. They are separate questions with separate answers.
      canRecord: hears.can,
      localTranscription: true,
      // FluidAudio on Apple silicon, ONNX Runtime everywhere else, same model.
      engine: parakeetAvailable() ? 'fluidaudio' : onnxReady() ? 'onnx' : null,
      onnx: onnxState(),
      hears,
    })
  })
  /* Parakeet, downloaded and built once on this Mac. The script ships with
   * the app; it needs Xcode's command line tools. */
  app.post('/transcribe/install', (c) => {
    // Off Apple silicon the same model comes as ONNX, which is a download
    // rather than a build, so there is nothing to compile and nothing to
    // apologise for.
    if (process.platform !== 'darwin') {
      onnxDownload().catch(() => {})
      return c.json({ ok: true, onnx: onnxState() })
    }
    if (parakeetAvailable()) return c.json({ ok: true, install })
    if (install.state === 'running') return c.json({ ok: true, install })
    const here = dirname(fileURLToPath(import.meta.url))
    const script = [join(here, '..', 'scripts', 'build-parakeet.sh'), join(process.cwd(), 'scripts', 'build-parakeet.sh')].find((p) => existsSync(p))
    if (!script) return c.json({ error: 'The Parakeet setup script is missing from this build.' }, 500)
    install = { state: 'running', log: '', startedAt: Date.now() }
    const p = spawn(process.env.SHELL || '/bin/zsh', ['-lc', `sh "${script}"`], { env: { ...process.env, ALFREDO_HOME: appHome() } })
    const add = (d: Buffer) => (install.log = (install.log + d.toString()).slice(-4000))
    p.stdout.on('data', add)
    p.stderr.on('data', add)
    p.on('close', (code) => {
      install.state = code === 0 && parakeetAvailable() ? 'done' : 'failed'
    })
    return c.json({ ok: true, install })
  })
  app.post('/transcribe/start', async (c) => {
    if (audio.isRecording()) return c.json({ error: 'Already transcribing a meeting.' }, 409)
    const b = await c.req.json<{ title?: string; micOnly?: boolean }>().catch(() => ({}) as { title?: string; micOnly?: boolean })
    const id = randomUUID()
    const r = audio.start(id, !!b.micOnly)
    jobs.set(id, { id, title: b.title?.trim() || 'Meeting', project: projectOf(c), workspace: current()?.workspace.id, state: 'recording', startedAt: r.startedAt })
    return c.json({ id, startedAt: r.startedAt })
  })
  app.post('/transcribe/stop', async (c) => {
    const st = store()
    const b = await c.req.json<{ title?: string }>().catch(() => ({}) as { title?: string })
    const r = await audio.stop()
    const job = jobs.get(r.id) ?? { id: r.id, title: 'Meeting', state: 'recording' as const, startedAt: Date.now() - r.durationS * 1000 }
    if (b.title?.trim()) job.title = b.title.trim()
    jobs.set(r.id, job)
    finish(job, st, r.path, r.durationS, job.startedAt, current()?.workspace.id ?? '')
    return c.json({ id: r.id, systemAudio: r.systemAudio })
  })
  /* What is being recorded or written up right now, for the app's frame to
     draw wherever you are. A finished one stays a minute so a window that
     looked away can still notice it; a failed one until it is dismissed. */
  app.get('/transcribe/active', (c) => {
    const here = current()?.workspace.id
    const now = Date.now()
    return c.json(
      [...jobs.values()]
        .filter((j) => !j.workspace || j.workspace === here)
        .filter((j) => j.state !== 'done' || now - (j.endedAt ?? now) < 60_000)
        .map(({ project: _p, workspace: _w, ...j }) => j),
    )
  })
  app.delete('/transcribe/:id', (c) => {
    const j = jobs.get(c.req.param('id'))
    if (j && (j.state === 'failed' || j.state === 'done')) jobs.delete(j.id)
    return c.json({ ok: true })
  })
  app.get('/transcribe/:id', (c) => {
    const j = jobs.get(c.req.param('id'))
    return j ? c.json(j) : c.json({ error: 'unknown job' }, 404)
  })

  /* Upcoming meetings from Google Calendar, through Composio: every calendar
   * account this workspace uses, as one list in the order things happen. With
   * none chosen, whichever account the CLI falls to, as before. */
  app.get('/calendar/upcoming', async (c) => {
    const wsId = current()?.workspace.id ?? ''
    const aliases = accountsFor(current()?.workspace, 'googlecalendar')
    const key = `${wsId}|${aliases.join('+')}`
    /* Each account is a CLI run of a few seconds. The page should not sit on
       "Checking your calendar" for that every time it is opened: what was
       found last is handed over at once, and looked at again behind it. */
    const kept = calendars.get(key)
    const fresh = kept && Date.now() - kept.at < CALENDAR_FRESH_MS
    if (!fresh) void lookAgain(key, aliases)
    if (kept) return c.json({ ...kept.answer, checking: !fresh })
    await looking.get(key)
    return c.json(calendars.get(key)?.answer ?? { connected: false, events: [], calendars: [], error: 'Calendar unavailable' })
  })

  app.get('/asset', async (c) => {
    const cur = current()
    const src = c.req.query('src') ?? ''
    if (!cur || cur.workspace.kind !== 'cloudflare' || !(cur.db instanceof CloudflareWorkspace)) return c.json({ error: 'not found' }, 404)
    if (!/^\/assets\/[\w./-]+$/.test(src) || src.includes('..')) return c.json({ error: 'bad path' }, 400)
    const res = await cur.db.raw(src)
    return new Response(res.body, { status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? 'application/octet-stream', 'cache-control': 'private, max-age=3600' } })
  })

}

export const desktopMachine: Machine = {
  shelfFor,
  touch,
  forget,
  keepReadIn,
  inviteKeys: (workspace) => supabaseFor(workspace),
  thumbs: {
    read() {
      try {
        return existsSync(THUMBS) ? JSON.parse(readFileSync(THUMBS, 'utf8')) : {}
      } catch {
        return {}
      }
    },
    write(all) {
      try {
        mkdirSync(dirname(THUMBS), { recursive: true })
        writeFileSync(THUMBS, JSON.stringify(all))
      } catch {}
    },
  },
  routes,
}
