<script lang="ts">
  // Meetings: transcribed on this Mac by Parakeet. The audio is thrown away as
  // soon as the transcript exists; what stays is the transcript and the notes.
  import { canEditHere, afterMove } from './project.svelte'
  import { scope } from './project.svelte'
  import ProjectChip from './ProjectChip.svelte'
  import ItemMenu from './ItemMenu.svelte'
  import Cpu from '@lucide/svelte/icons/cpu'
  import Calendar from '@lucide/svelte/icons/calendar'
  import Plus from '@lucide/svelte/icons/plus'
  import Trash2 from '@lucide/svelte/icons/trash-2'
  import Header from './Header.svelte'
  import CopyNode from './CopyNode.svelte'
  import DocEditor from '../lib/DocEditor.svelte'
  import ActionItems from './ActionItems.svelte'
  import { v2, ago, type Meeting, type MeetingSummary } from './api'
  import { ui, go, openSettings } from './state.svelte'
  import { workspace } from '../lib/workspace.svelte'
  import Skeleton from './Skeleton.svelte'
  import { peek, load as fetchCached, put, prefetch } from './cache'
  import { rec, recordingNow, writingUp, failedJobs, startRecording, stopRecording, dismiss, onMeetingReady, sync as syncJobs } from './recording.svelte'

  let { tabId, tabName = 'Meetings' }: { tabId: string; tabName?: string } = $props()

  type Event = { id: string; title: string; start: string; end: string; link: string | null; people: number; account?: string; calendar?: string }

  let meetings = $state<MeetingSummary[]>(peek<MeetingSummary[]>('/meetings') ?? [])
  let loading = $state(!peek('/meetings'))
  type Install = { state: 'idle' | 'running' | 'done' | 'failed'; log: string }
  type Hears = { can: boolean; both: boolean; why: string; fix?: 'screen' }
  type Onnx = { state: 'idle' | 'downloading' | 'ready' | 'failed'; got: number; of: number; error?: string }
  let engine = $state<{ parakeet: boolean; recording: boolean; install: Install; canRecord?: boolean; localTranscription?: boolean; engine?: string | null; onnx?: Onnx; hears?: Hears } | null>(null)
  type Upcoming = { connected: boolean; accounts?: number; calendars?: string[]; checking?: boolean; events: Event[] }
  // What was there last time, at once; the calendars are asked again behind it.
  let upcoming = $state<Upcoming | null>(peek<Upcoming>('/calendar/upcoming') ?? null)
  // What is being recorded or written up lives in the app's frame, not here:
  // see recording.svelte.ts. This page only draws it.
  const job = $derived(recordingNow())
  let now = $state(Date.now())
  let meeting = $state<Meeting | null>(null)
  let view = $state<'notes' | 'transcript'>('notes')
  let notesKey = $state(0)
  let saving = $state<'idle' | 'saving' | 'saved'>('idle')
  let timer: ReturnType<typeof setTimeout> | undefined

  async function load() {
    loading = true
    try {
      meetings = await fetchCached<MeetingSummary[]>('/meetings')
    } catch (e) {
      ui.error = (e as Error).message
    }
    loading = false
  }
  load()
  async function checkEngine() {
    engine = await v2.get<{ parakeet: boolean; recording: boolean; install: Install; canRecord?: boolean; localTranscription?: boolean; engine?: string | null; onnx?: Onnx; hears?: Hears }>('/transcribe/engine').catch(() => engine)
    if (engine?.install.state === 'running' || engine?.onnx?.state === 'downloading') setTimeout(checkEngine, 3000)
  }
  /* Recording needs a microphone and a model on a disk, and the calendar comes
     through a CLI: on the site a meeting is its notes, written or pasted. */
  const onAMachine = !workspace.hosted
  /** Asks macOS for the screen's audio, then looks again once it may have been given. */
  async function allowScreen() {
    await v2.post('/transcribe/permissions/screen', {}).catch(() => {})
    setTimeout(checkEngine, 4000)
    setTimeout(checkEngine, 15000)
  }
  /** Forget what macOS has on record for Alfredo, so the next ask is a real one. */
  async function resetScreen() {
    await v2.post('/transcribe/permissions/screen', { reset: true }).catch(() => {})
    setTimeout(checkEngine, 4000)
    setTimeout(checkEngine, 15000)
  }
  if (onAMachine) checkEngine()
  async function download() {
    try {
      await v2.post('/transcribe/install', {})
      checkEngine()
    } catch (e) {
      ui.error = (e as Error).message
    }
  }
  async function loadUpcoming(again = 0) {
    try {
      upcoming = await fetchCached<Upcoming>('/calendar/upcoming')
      // The server answers with what it had and looks again: ask once more for that.
      if (upcoming.checking && again < 3) setTimeout(() => loadUpcoming(again + 1), 5000)
    } catch {
      upcoming ??= { connected: false, events: [] }
    }
  }
  if (onAMachine) loadUpcoming()

  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 1000)
    return () => clearInterval(t)
  })

  $effect(() => {
    const id = ui.item
    if (!id) {
      meeting = null
      return
    }
    view = 'notes'
    meeting = peek<Meeting>(`/meetings/${id}`) ?? null
    fetchCached<Meeting>(`/meetings/${id}`)
      .then((m) => {
        if (ui.item === id && (!meeting || saving !== 'saving')) meeting = m
      })
      .catch((e) => (ui.error = (e as Error).message))
  })

  async function start(t = '') {
    if (await startRecording(t)) go(tabId)
  }
  const stop = () => stopRecording()
  // A meeting written up while this list is on screen joins it.
  $effect(() => onMeetingReady(() => load()))
  if (onAMachine) syncJobs()

  const clock = (ms: number) => {
    const s = Math.max(0, Math.floor(ms / 1000))
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  }
  const dur = (s: number | null) => (s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : '')
  const day = (iso: string) => new Date(iso)

  function queue(patch: Partial<Pick<Meeting, 'title' | 'notes'>>) {
    if (!meeting) return
    meeting = { ...meeting, ...patch }
    saving = 'saving'
    clearTimeout(timer)
    timer = setTimeout(save, 700)
  }
  async function save() {
    if (!meeting) return
    try {
      const m = await v2.put<Meeting>(`/meetings/${meeting.id}`, { title: meeting.title, notes: meeting.notes, revision: meeting.revision })
      if (meeting?.id === m.id) meeting = { ...meeting, revision: m.revision }
      meetings = meetings.map((x) => (x.id === m.id ? { ...x, title: m.title } : x))
      saving = 'saved'
    } catch (e) {
      saving = 'idle'
      ui.error = (e as Error).message
    }
  }

  /** A meeting nobody recorded: a call you took notes in, or one written up after. */
  async function create() {
    try {
      const m = await v2.post<Meeting>('/meetings', { title: 'Meeting', notes: '' })
      meetings = [{ id: m.id, title: m.title, startedAt: m.startedAt, durationS: m.durationS, hasTranscript: false, status: m.status, project: m.project ?? null }, ...meetings]
      put('/meetings', meetings)
      go(tabId, m.id)
    } catch (e) {
      ui.error = (e as Error).message
    }
  }

  /** From a meeting's three dots in the list. */
  async function removeFromList(m: { id: string; title: string }) {
    if (!confirm(`Delete “${m.title}”? Its transcript and notes go too.`)) return
    const before = meetings
    meetings = meetings.filter((x) => x.id !== m.id)
    put('/meetings', meetings)
    try {
      await v2.del(`/meetings/${m.id}`)
    } catch (e) {
      meetings = before
      put('/meetings', before)
      ui.error = (e as Error).message
    }
  }

  async function remove() {
    if (!meeting || !confirm(`Delete “${meeting.title}”? Its transcript and notes go too.`)) return
    const id = meeting.id
    const before = meetings
    meetings = meetings.filter((m) => m.id !== id)
    put('/meetings', meetings)
    go(tabId)
    try {
      await v2.del(`/meetings/${id}`)
    } catch (e) {
      meetings = before
      put('/meetings', before)
      ui.error = (e as Error).message
    }
  }

  /** A transcript in the parts it is drawn in: when, then what was said. */
  const said = (transcript: string) =>
    transcript
      .split(/\n{2,}/)
      .map((block) => block.trim())
      .filter(Boolean)
      .map((block) => {
        const m = /^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*/.exec(block)
        return m ? { at: m[1], text: block.slice(m[0].length) } : { at: null, text: block }
      })

  const when = (iso: string) =>
    new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  const until = (iso: string) => {
    const m = Math.round((new Date(iso).getTime() - now) / 60000)
    return m <= 0 ? 'now' : m < 60 ? `in ${m} min` : m < 1440 ? `in ${Math.round(m / 60)} h` : ''
  }
</script>

{#if ui.item && !meeting}
  <div class="page">
    <Header crumbs={[{ label: tabName, onclick: () => go(tabId) }, meetings.find((m) => m.id === ui.item)?.title ?? '']} />
    <div class="scroll"><article><div class="skel"><Skeleton w="55%" h={30} r={6} /><Skeleton w="25%" h={11} /><Skeleton w="92%" h={13} /><Skeleton w="84%" h={13} /><Skeleton w="66%" h={13} /></div></article></div>
  </div>
{:else if meeting}
  <div class="page">
    <Header crumbs={[{ label: tabName, onclick: () => go(tabId) }, meeting.title]}>
      <span class="state">{saving === 'saving' ? 'Saving…' : ''}</span>
      <CopyNode
        text={() => `${meeting!.notes}${meeting!.transcript ? `\n\n## Transcript\n\n${meeting!.transcript}` : ''}`}
        as={{ kind: 'meeting', id: meeting!.id, title: meeting!.title }}
        size={13}
      />
      <button class="del" title="Delete meeting" onclick={remove}><Trash2 size={13} /></button>
    </Header>
    <div class="scroll">
      <article>
        <input class="mtitle" value={meeting.title} oninput={(e) => queue({ title: e.currentTarget.value })} />
        <div class="meta">
          <span>{when(meeting.startedAt)}</span>
          {#if meeting.durationS}<span>· {dur(meeting.durationS)}</span>{/if}
        </div>
        <div class="tabs">
          <button class:on={view === 'notes'} onclick={() => (view = 'notes')}>Notes</button>
          <button class:on={view === 'transcript'} onclick={() => (view = 'transcript')} disabled={!meeting.transcript}>Transcript</button>
          <span class="grow"></span>
          <!-- Half a meeting is often the half worth pasting. -->
          <CopyNode
            text={() => (view === 'notes' ? meeting!.notes : (meeting!.transcript ?? ''))}
            as={{ kind: 'meeting', id: meeting!.id, title: `${meeting!.title} (${view})` }}
            label={view === 'notes' ? 'Copy the notes for your AI' : 'Copy the transcript for your AI'}
          />
        </div>
        {#if view === 'notes'}
          <ActionItems {meeting} canEdit={canEditHere()} onnotes={(md) => ((meeting!.notes = md), notesKey++, queue({ notes: md }))} />
          <!-- Re-made when the notes were changed from outside the editor (a card ref written in). -->
          {#key `${meeting.id}:${notesKey}`}
            <DocEditor value={meeting.notes} onchange={(md) => queue({ notes: md })} placeholder="Notes appear here after the meeting. Write your own too." />
          {/key}
        {:else}
          <!-- Each paragraph opens with the moment it began, "[12:40] "; an
               older transcript with none in it is drawn as it always was. -->
          <div class="transcript">
            {#each said(meeting.transcript ?? '') as part, i (i)}
              <div class="turn" class:timed={!!part.at}>
                {#if part.at}<span class="at">{part.at}</span>{/if}
                <p>{part.text}</p>
              </div>
            {/each}
          </div>
        {/if}
      </article>
    </div>
  </div>
{:else if job}
  <div class="page">
    <Header crumbs={[{ label: tabName, onclick: () => go(tabId) }, rec.title || 'New meeting']}>
      <span class="state"><Cpu size={12} /> Parakeet · on this Mac</span>
    </Header>
    <div class="live">
      <div class="rec"><i></i><span>Listening</span><b>{clock(now - job.startedAt)}</b></div>
      <input class="mtitle big" placeholder="Name this meeting" bind:value={rec.title} />
      <p class="note">
        Recording {engine?.hears?.why ?? 'this machine'}. Carry on with anything else in Alfredo: the recorder stays at the bottom of the window,
        and when you stop, the transcript and notes are written in the background and the meeting turns up here. The audio is deleted right after.
      </p>
    </div>
  </div>
{:else}
  <div class="page">
    <Header crumbs={[tabName]}>
      {#if canEditHere()}
        <button class="ghost" onclick={create}><Plus size={12} /><span>New meeting</span></button>
        {#if onAMachine}<button class="primary" disabled={engine?.canRecord === false || (engine?.parakeet === false && !engine?.engine)} title={engine?.canRecord === false ? 'Recording needs a Mac' : ''} onclick={() => start()}><i class="dot"></i><span>Transcribe</span></button>{/if}
      {/if}
    </Header>
    <div class="scroll">
      <div class="home">
        {#if engine && engine.canRecord !== false && engine.hears && !engine.hears.both}
          <div class="model quiet">
            <div class="mi"><Cpu size={17} /></div>
            <div class="mt">
              <span class="h">This machine hears one side of a call</span>
              <span class="s">Recording picks up {engine.hears.why}.{#if engine.hears.fix === 'screen'} macOS calls it Screen & System Audio Recording, under Privacy & Security: Allow asks for it there. If it already shows as on for Alfredo and still does not count (a permission from an earlier build), Reset clears that entry so macOS asks again.{/if}</span>
            </div>
            {#if engine.hears.fix === 'screen'}
              <div class="acts">
                <button class="primary sm" onclick={allowScreen}>Allow</button>
                <button class="ghost sm" onclick={resetScreen}>Reset</button>
              </div>
            {/if}
          </div>
        {/if}
        {#if engine && engine.canRecord === false}
          <div class="model">
            <div class="mi"><Cpu size={17} /></div>
            <div class="mt">
              <span class="h">Nothing here to record with</span>
              <span class="s">Alfredo records {engine.hears?.why ?? 'nothing yet'}. Meetings you write yourself work either way.</span>
            </div>
            <button class="primary sm" onclick={create}>New meeting</button>
          </div>
        {:else if engine && !engine.parakeet && !engine.engine}
          <div class="model">
            <div class="mi"><Cpu size={17} /></div>
            <div class="mt">
              <span class="h">Download the transcription model</span>
              <span class="s">
                {engine.install.state === 'running' || engine.onnx?.state === 'downloading'
                  ? `Downloading Parakeet${engine.onnx?.state === 'downloading' ? ` (${engine.onnx.got} of ${engine.onnx.of} files)` : ''}. This takes a few minutes the first time; you can keep working.`
                  : engine.install.state === 'failed' || engine.onnx?.state === 'failed'
                    ? (engine.onnx?.error ?? 'The download did not finish. It needs Xcode command line tools (xcode-select --install); then try again.')
                    : 'Meetings are transcribed on this machine by Parakeet, so audio never leaves it. One download, about 600 MB.'}
              </span>
              {#if engine.install.state === 'running' || engine.onnx?.state === 'downloading'}<div class="prog"><i></i></div>{/if}
            </div>
            {#if engine.install.state !== 'running' && engine.onnx?.state !== 'downloading'}
              <button class="primary sm" onclick={download}>{engine.install.state === 'failed' || engine.onnx?.state === 'failed' ? 'Try again' : 'Download'}</button>
            {/if}
          </div>
        {/if}

        {#if onAMachine}
        <section>
          <div class="sh">
            <span>Up next</span>
            <!-- Which calendars, by the address they belong to: "Google Calendar"
                 alone does not say whether this is the work one. -->
            <button class="src" title="Choose which calendars this workspace uses" onclick={() => openSettings('connections')}>
              <Calendar size={12} />{upcoming?.calendars?.length ? upcoming.calendars.join(' · ') : 'Google Calendar'}
            </button>
          </div>
          {#if upcoming === null}
            <p class="empty">Checking your calendar…</p>
          {:else if !upcoming.connected}
            <div class="connect">
              <span>Connect Google Calendar to see upcoming meetings here and transcribe them in one click.</span>
              <button class="ghost" onclick={() => openSettings('connections')}>Connect</button>
            </div>
          {:else if upcoming.events.length === 0}
            <p class="empty">Nothing on the calendar.</p>
          {:else}
            {#each upcoming.events as ev (`${ev.account ?? ''}:${ev.id}`)}
              <div class="event">
                <span class="bar"></span>
                <!-- Whose calendar, once there is more than one it could be. -->
                <div class="et"><span class="h">{ev.title}</span><span class="s">{when(ev.start)}{ev.people ? ` · ${ev.people} people` : ''}{(upcoming.accounts ?? 0) > 1 && ev.calendar ? ` · ${ev.calendar}` : ''}</span></div>
                <span class="soon">{until(ev.start)}</span>
                <button class="primary sm" disabled={engine?.canRecord === false || (engine?.parakeet === false && !engine?.engine)} onclick={() => start(ev.title)}><i class="dot"></i>Transcribe</button>
              </div>
            {/each}
          {/if}
        </section>
        {/if}

        <section>
          <div class="sh"><span>Meetings</span></div>
          <!-- Stopped, and being turned into a meeting behind the screen. -->
          {#each writingUp() as j (j.id)}
            <div class="row pending">
              <div class="date spin"><i></i></div>
              <div class="rt"><span class="h">{j.title || 'Meeting'}</span><span class="s">{j.state === 'transcribing' ? 'Transcribing on this Mac…' : 'Writing the notes…'} About a minute per ten minutes of meeting.</span></div>
            </div>
          {/each}
          {#each failedJobs() as j (j.id)}
            <div class="row pending failed">
              <div class="rt"><span class="h">{j.title || 'Meeting'} did not work</span><span class="s">{j.error}</span></div>
              <button class="ghost" onclick={() => dismiss(j.id)}>Dismiss</button>
            </div>
          {/each}
          {#each meetings as m (m.id)}
            <button class="row" onclick={() => go(tabId, m.id)} onmouseenter={() => prefetch(`/meetings/${m.id}`)}>
              <div class="date"><span>{day(m.startedAt).toLocaleDateString(undefined, { weekday: 'short' })}</span><b>{day(m.startedAt).getDate()}</b></div>
              <div class="rt"><span class="h">{m.title}</span><span class="s">{m.hasTranscript ? 'Transcript and notes' : m.status === 'failed' ? 'Transcription failed' : 'Notes'} · {ago(m.startedAt)}</span></div>
              <ProjectChip passive kind="meeting" id={m.id} project={m.project ?? null} />
              <span class="d">{dur(m.durationS)}</span>
              {#if canEditHere()}<span class="more"><ItemMenu kind="meeting" id={m.id} project={m.project ?? null} onopen={() => go(tabId, m.id)} onmoved={(p) => ((meetings = afterMove(meetings, m.id, p)), put('/meetings', meetings))} ondelete={() => removeFromList(m)} /></span>{/if}
            </button>
          {:else}
            {#if writingUp().length || failedJobs().length}
              <!-- One on its way is not "no meetings yet". -->
            {:else if loading}
              {#each [0, 1, 2] as _}<div class="row sk"><Skeleton w={32} h={30} r={6} /><div class="rt"><Skeleton w="50%" h={12} /><Skeleton w="30%" h={10} /></div></div>{/each}
            {:else}
              <p class="empty">
                {#if scope.enabled && scope.id}Nothing here yet. Meetings {onAMachine ? 'you record' : 'recorded in the desktop app'} in this project land here; to move an existing one, open the project it is in (or Unfiled) and use its three dots.
                {:else if onAMachine}No meetings yet.
                {:else}No meetings yet. Recording and transcribing happen in the desktop app; what it saves shows up here.{/if}
              </p>
            {/if}
          {/each}
        </section>
      </div>
    </div>
  </div>
{/if}

<style>
  .acts {
    display: flex;
    gap: 6px;
    flex: none;
  }

  .page {
    height: 100%;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .scroll {
    flex: 1;
    overflow: auto;
  }
  .home {
    max-width: 760px;
    margin: 0 auto;
    padding: 40px 48px;
    display: flex;
    flex-direction: column;
    gap: 32px;
  }
  /* The same card, saying something smaller: a limit, not a thing to do. */
  .model.quiet {
    background: none;
    border-style: dashed;
  }
  .model {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    padding: 20px;
    border-radius: 12px;
    background: var(--panel);
    border: 1px solid var(--line-strong);
  }
  .mi {
    width: 36px;
    height: 36px;
    flex-shrink: 0;
    border-radius: 9px;
    background: var(--raised);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .mt {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .h {
    font-size: 14px;
    font-weight: 600;
  }
  .s {
    font-size: 12px;
    color: var(--muted);
    line-height: 1.5;
  }
  .prog {
    height: 3px;
    margin-top: 8px;
    border-radius: 2px;
    background: var(--line-strong);
    overflow: hidden;
  }
  .prog i {
    display: block;
    height: 100%;
    width: 30%;
    background: var(--ink-2);
    animation: slide 1.4s ease-in-out infinite;
  }
  @keyframes slide {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(340%);
    }
  }
  .ok {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--ink-2);
  }
  .ok i {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--running);
  }
  section {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .sh {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 32px;
    border-bottom: 1px solid var(--line);
    font-size: 15px;
    font-weight: 500;
  }
  .src {
    display: flex;
    align-items: center;
    gap: 6px;
    font: inherit;
    font-size: 12px;
    font-weight: 400;
    color: var(--muted);
    background: none;
    border: 0;
    padding: 0;
    cursor: pointer;
  }
  .src:hover {
    color: var(--ink);
  }
  .connect {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 12px 14px;
    border-radius: 10px;
    border: 1px dashed var(--line-strong);
    font-size: 13px;
    color: var(--ink-2);
  }
  .connect span {
    flex: 1;
  }
  .event {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 12px 14px;
    border-radius: 10px;
    border: 1px solid var(--line-strong);
    background: var(--panel);
  }
  .bar {
    width: 4px;
    align-self: stretch;
    border-radius: 2px;
    background: #b4c3d3;
  }
  .et,
  .rt {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }
  .soon {
    font-size: 12px;
    color: var(--ink-2);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 14px;
    height: 60px;
    border: 0;
    border-bottom: 1px solid var(--line);
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .row:hover {
    background: var(--accent-soft);
  }
  .date {
    width: 40px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  .date span {
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted);
  }
  .date b {
    font-size: 17px;
  }
  .d {
    width: 56px;
    text-align: right;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
  }
  .empty {
    font-size: 13px;
    color: var(--muted);
  }
  .primary {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 10px;
    border-radius: var(--r-md);
    background: var(--ink);
    color: var(--on-accent);
    border: 0;
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }
  .primary:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .primary.sm {
    height: 28px;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #e5484d;
  }
  .ghost {
    /* An icon and a word sit on one line only when the button says so: left
       as inline content the plus rides its own baseline, above the text. */
    display: flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 10px;
    border-radius: var(--r-md);
    border: 1px solid var(--line-strong);
    background: var(--raised);
    color: var(--ink);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .state {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--muted);
  }
  .live {
    flex: 1;
    max-width: 720px;
    width: 100%;
    margin: 0 auto;
    padding: 48px;
    display: flex;
    flex-direction: column;
    gap: 20px;
    position: relative;
    box-sizing: border-box;
  }
  .rec {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: #e5484d;
  }
  .rec i {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: #e5484d;
    box-shadow: 0 0 0 4px rgba(229, 72, 77, 0.18);
  }
  .rec b {
    font-family: var(--mono);
    font-weight: 400;
    color: var(--ink-2);
    letter-spacing: 0;
  }
  h2 {
    margin: 0;
    font-size: 24px;
    font-weight: 600;
    letter-spacing: -0.02em;
  }
  .note {
    font-size: 13px;
    color: var(--muted);
    line-height: 1.6;
    margin: 0;
  }
  .err {
    color: var(--danger);
  }
  .more {
    display: inline-flex;
    opacity: 0;
    transition: opacity 0.12s;
  }
  .row:hover .more,
  .more:focus-within,
  .more:has(:global(.open)) {
    opacity: 1;
  }
  .pending {
    cursor: default;
  }
  .pending.failed .s {
    color: var(--danger);
  }
  .spin {
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .spin i {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 2px solid var(--line-strong);
    border-top-color: var(--ink-2);
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  article {
    max-width: 720px;
    margin: 0 auto;
    padding: 40px 48px 120px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .mtitle {
    font: inherit;
    font-size: 32px;
    font-weight: 600;
    letter-spacing: -0.03em;
    background: none;
    border: 0;
    outline: none;
    color: var(--ink);
  }
  .meta {
    display: flex;
    gap: 6px;
    font-size: 12px;
    color: var(--muted);
  }
  .tabs {
    display: flex;
    align-items: center;
    gap: 18px;
    border-bottom: 1px solid var(--line);
    margin: 8px 0 4px;
  }
  .tabs .grow {
    flex: 1;
  }
  .tabs button {
    padding: 0 0 10px;
    border: 0;
    background: none;
    color: var(--muted);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
    border-bottom: 1.5px solid transparent;
  }
  .tabs button.on {
    color: var(--ink);
    border-color: var(--ink);
  }
  .tabs button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .skel {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .row.sk {
    cursor: default;
  }
  .transcript {
    display: flex;
    flex-direction: column;
    gap: 14px;
    font-size: 14px;
    line-height: 1.65;
    color: var(--ink-2);
  }
  .turn p {
    margin: 0;
    white-space: pre-wrap;
  }
  .turn.timed {
    display: grid;
    grid-template-columns: 52px 1fr;
    column-gap: 10px;
  }
  .at {
    font-family: var(--mono);
    font-size: 11px;
    line-height: 23px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
    user-select: none;
  }

  .del {
    background: none;
    border: 0;
    color: var(--muted);
    cursor: pointer;
    display: flex;
    padding: 3px;
    border-radius: 4px;
  }
  .del:hover {
    color: var(--danger);
  }
</style>
