// A meeting being recorded or written up, wherever in the app you are.
//
// This used to live inside the Meetings tab, so it lived as long as the tab
// was on screen: leave to look at a card and the recorder was gone (the
// recording was not, which is worse), and stopping one swapped the whole page
// for "Transcribing on this Mac" until it was done. The Mac does that work
// without anybody watching. So what is going on is kept here, asked of the
// server rather than remembered, and drawn by the app's frame: a recorder you
// can stop from anywhere, and a meeting that turns up in the list when it is
// ready.
import { v2 } from './api'
import { ui } from './state.svelte'

export type Job = {
  id: string
  title: string
  state: 'recording' | 'transcribing' | 'writing' | 'done' | 'failed'
  meetingId?: string
  error?: string
  startedAt: number
  endedAt?: number
}

export const rec = $state<{ jobs: Job[]; title: string; ready: Job | null; call: Call | null; ended: boolean }>({ jobs: [], title: '', ready: null, call: null, ended: false })

/** A call the machine can see going on: the app it is in, and when it was first seen. */
export type Call = { app: string; since: number; known: boolean; event?: CalEvent | null }
export type CalEvent = { id: string; title: string; start: string; end: string; link: string | null }

export const recordingNow = () => rec.jobs.find((j) => j.state === 'recording') ?? null
export const writingUp = () => rec.jobs.filter((j) => j.state === 'transcribing' || j.state === 'writing')
export const failedJobs = () => rec.jobs.filter((j) => j.state === 'failed')

/** Told when a meeting has been written up, so a list on screen can show it. */
const listeners = new Set<(job: Job) => void>()
export const onMeetingReady = (fn: (job: Job) => void) => {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}

let timer: ReturnType<typeof setTimeout> | undefined
const announced = new Set<string>()

export async function sync() {
  clearTimeout(timer)
  const jobs = await v2.get<Job[]>('/transcribe/active').catch(() => null)
  if (jobs) {
    for (const job of jobs) {
      if (job.state !== 'done' || announced.has(job.id)) continue
      announced.add(job.id)
      // Only one that was seen being worked on is news; one that was already
      // done when the app opened is just a meeting in the list.
      if (rec.jobs.some((j) => j.id === job.id && j.state !== 'done')) {
        rec.ready = job
        for (const fn of listeners) fn(job)
      }
    }
    rec.jobs = jobs.filter((j) => j.state !== 'done')
  }
  if (rec.jobs.some((j) => j.state !== 'failed')) timer = setTimeout(sync, 1500)
}

export async function startRecording(title = '') {
  try {
    const r = await v2.post<{ id: string; startedAt: number }>('/transcribe/start', { title: title || rec.title })
    rec.jobs = [...rec.jobs, { id: r.id, title: title || rec.title || 'Meeting', state: 'recording', startedAt: r.startedAt }]
    if (title) rec.title = title
    sync()
    return true
  } catch (e) {
    ui.error = (e as Error).message
    return false
  }
}

export async function stopRecording() {
  const job = recordingNow()
  if (!job) return
  try {
    await v2.post('/transcribe/stop', { title: rec.title })
    rec.jobs = rec.jobs.map((j) => (j.id === job.id ? { ...j, state: 'transcribing' as const, title: rec.title || j.title } : j))
    rec.title = ''
    sync()
  } catch (e) {
    ui.error = (e as Error).message
  }
}

export async function dismiss(id: string) {
  rec.jobs = rec.jobs.filter((j) => j.id !== id)
  await v2.del(`/transcribe/${id}`).catch(() => {})
}


// --- calls: offer to record one that starts, and to stop when it ends ----------
//
// The machine can tell when a call is on (a Meet, Zoom or Teams window; or
// the microphone open in another app). Nothing starts on its own: the app
// says what it sees and offers the one button that fits, and a call that was
// waved away stays waved away.
let callTimer: ReturnType<typeof setTimeout> | undefined
let wavedAway = 0 // the `since` of the call that was declined
let quiet = 0 // polls in a row with no call, while recording one
const CALL_EVERY_MS = 6000

let told = '' // the last notification sent, so each is sent once
let listeningForNotes = false
function say(id: string, title: string, body: string, action: string) {
  const key = `${id}|${title}|${body}`
  if (told === key || !window.alfredo?.notify) return
  told = key
  window.alfredo.notify({ id, title, body, action })
}

export async function watchCalls() {
  clearTimeout(callTimer)
  if (!listeningForNotes && window.alfredo?.onNotificationAction) {
    listeningForNotes = true
    window.alfredo.onNotificationAction(({ id, action }) => {
      if (id === 'call' && action !== 'open') void recordThisCall()
      if (id === 'ended' && action !== 'open') void stopRecording()
    })
  }
  const seen = await v2.get<{ inCall: boolean; app: string | null; known: boolean; event?: CalEvent | null }>('/transcribe/call').catch(() => null)
  if (seen) {
    const recording = recordingNow()
    if (seen.inCall) {
      quiet = 0
      rec.ended = false
      if (!rec.call) rec.call = { app: seen.app ?? 'A call', since: Date.now(), known: seen.known, event: seen.event ?? null }
      else if ((seen.known && !rec.call.known) || (seen.event && !rec.call.event)) rec.call = { ...rec.call, app: seen.app ?? rec.call.app, known: rec.call.known || seen.known, event: rec.call.event ?? seen.event ?? null }
      if (offerToRecord()) {
        const what = rec.call!.event?.title ?? (rec.call!.app === 'A call' ? 'A call' : rec.call!.app)
        say('call', 'A meeting seems to be going on', `${what}${rec.call!.event && rec.call!.app !== 'A call' ? ` (${rec.call!.app})` : ''}. Transcribe it?`, 'Transcribe')
      }
    } else if (rec.call) {
      // Only a call the machine could name is worth saying has ended: while
      // recording, the microphone being open is Alfredo itself.
      if (recording && rec.call.known) {
        quiet++
        if (quiet >= 3) {
          rec.ended = true
          rec.call = null
        }
      } else {
        rec.call = null
        quiet = 0
      }
    }
    // The calendar's word: the event this recording was for has been over a while.
    if (recording && !rec.ended && rec.call?.event && Date.parse(rec.call.event.end) + 3 * 60_000 < Date.now() && !seen.known) {
      rec.ended = true
      rec.call = null
    }
    if (recording && rec.ended) say('ended', 'Seems like your meeting ended', `Stop and write “${rec.title || recording.title || 'Meeting'}” up?`, 'Stop')
  }
  callTimer = setTimeout(watchCalls, CALL_EVERY_MS)
}

/** The offer to record this call: shown until taken or waved away. A call the
 *  machine could not name is only the microphone being open somewhere, which
 *  dictation does too; that one is offered once it has lasted a while. */
export const offerToRecord = () => !!rec.call && !recordingNow() && rec.call.since !== wavedAway && (rec.call.known || Date.now() - rec.call.since > 90_000)
export function waveAway() {
  if (rec.call) wavedAway = rec.call.since
}
export async function recordThisCall() {
  if (recordingNow()) return
  const app = rec.call?.app ?? ''
  // The calendar's name for it beats the app's.
  const ok = await startRecording(rec.call?.event?.title ?? (app && app !== 'A call' ? `${app} call` : ''))
  if (ok) rec.ended = false
}
