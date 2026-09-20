<script lang="ts">
  // Meetings: transcribed on this Mac by Parakeet. The audio is thrown away as
  // soon as the transcript exists; what stays is the transcript and the notes.
  import { scope } from './project.svelte'
  import ProjectChip from './ProjectChip.svelte'
  import ProjectPicker from './ProjectPicker.svelte'
  import { canEditHere } from './project.svelte'
  import Cpu from '@lucide/svelte/icons/cpu'
  import Calendar from '@lucide/svelte/icons/calendar'
  import Plus from '@lucide/svelte/icons/plus'
  import Trash2 from '@lucide/svelte/icons/trash-2'
  import Header from './Header.svelte'
  import CopyNode from './CopyNode.svelte'
  import DocEditor from '../lib/DocEditor.svelte'
  import { v2, ago, type Meeting, type MeetingSummary } from './api'
  import { ui, go, openSettings } from './state.svelte'
  import Skeleton from './Skeleton.svelte'
  import { peek, load as fetchCached, put, prefetch } from './cache'

  let { tabId, tabName = 'Meetings' }: { tabId: string; tabName?: string } = $props()

  type Job = { id: string; state: 'recording' | 'transcribing' | 'writing' | 'done' | 'failed'; meetingId?: string; error?: string; startedAt: number }
  type Event = { id: string; title: string; start: string; end: string; link: string | null; people: number }

  let meetings = $state<MeetingSummary[]>(peek<MeetingSummary[]>('/meetings') ?? [])
  let loading = $state(!peek('/meetings'))
  type Install = { state: 'idle' | 'running' | 'done' | 'failed'; log: string }
  let engine = $state<{ parakeet: boolean; recording: boolean; install: Install } | null>(null)
  let upcoming = $state<{ connected: boolean; events: Event[] } | null>(null)
  let job = $state<Job | null>(null)
  let title = $state('')
  let now = $state(Date.now())
  let meeting = $state<Meeting | null>(null)
  let view = $state<'notes' | 'transcript'>('notes')
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
    engine = await v2.get<{ parakeet: boolean; recording: boolean; install: Install }>('/transcribe/engine').catch(() => engine)
    if (engine?.install.state === 'running') setTimeout(checkEngine, 3000)
  }
  checkEngine()
  async function download() {
    try {
      await v2.post('/transcribe/install', {})
      checkEngine()
    } catch (e) {
      ui.error = (e as Error).message
    }
  }
  v2.get<{ connected: boolean; events: Event[] }>('/calendar/upcoming').then((u) => (upcoming = u)).catch(() => (upcoming = { connected: false, events: [] }))

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
    try {
      const r = await v2.post<{ id: string; startedAt: number }>('/transcribe/start', { title: t || title })
      job = { id: r.id, state: 'recording', startedAt: r.startedAt }
      go(tabId)
    } catch (e) {
      ui.error = (e as Error).message
    }
  }
  async function stop() {
    if (!job) return
    try {
      const r = await v2.post<{ id: string }>('/transcribe/stop', { title })
      job = { ...job, id: r.id, state: 'transcribing' }
      poll(r.id)
    } catch (e) {
      ui.error = (e as Error).message
    }
  }
  async function poll(id: string) {
    const j = await v2.get<Job>(`/transcribe/${id}`).catch(() => null)
    if (!j) return
    job = j
    if (j.state === 'done' && j.meetingId) {
      await load()
      job = null
      title = ''
      go(tabId, j.meetingId)
      return
    }
    if (j.state === 'failed') return
    setTimeout(() => poll(id), 1500)
  }

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
      <CopyNode text={() => `# ${meeting!.title}\n\n${meeting!.notes}${meeting!.transcript ? `\n\n## Transcript\n\n${meeting!.transcript}` : ''}`} size={13} />
      <button class="del" title="Delete meeting" onclick={remove}><Trash2 size={13} /></button>
    </Header>
    <div class="scroll">
      <article>
        <input class="mtitle" value={meeting.title} oninput={(e) => queue({ title: e.currentTarget.value })} />
        <div class="meta">
          <ProjectPicker kind="meeting" id={meeting.id} project={meeting.project ?? null} onchange={(p) => (meeting && (meeting.project = p), (meetings = meetings.map((x) => (x.id === meeting?.id ? { ...x, project: p } : x))))} />
          <span>{when(meeting.startedAt)}</span>
          {#if meeting.durationS}<span>· {dur(meeting.durationS)}</span>{/if}
        </div>
        <div class="tabs">
          <button class:on={view === 'notes'} onclick={() => (view = 'notes')}>Notes</button>
          <button class:on={view === 'transcript'} onclick={() => (view = 'transcript')} disabled={!meeting.transcript}>Transcript</button>
        </div>
        {#if view === 'notes'}
          {#key meeting.id}
            <DocEditor value={meeting.notes} onchange={(md) => queue({ notes: md })} placeholder="Notes appear here after the meeting. Write your own too." />
          {/key}
        {:else}
          <pre class="transcript">{meeting.transcript}</pre>
        {/if}
      </article>
    </div>
  </div>
{:else if job}
  <div class="page">
    <Header crumbs={[{ label: tabName, onclick: () => {} }, 'New meeting']}>
      <span class="state"><Cpu size={12} /> Parakeet · on this Mac</span>
    </Header>
    <div class="live">
      {#if job.state === 'recording'}
        <div class="rec"><i></i><span>Listening</span><b>{clock(now - job.startedAt)}</b></div>
        <input class="mtitle big" placeholder="Name this meeting" bind:value={title} />
        <p class="note">Speech is turned into text on this Mac when you stop. The audio is deleted right after; only the transcript and notes are kept.</p>
        <div class="recorder">
          <div class="wave">{#each Array(14) as _, i}<span style:height="{6 + ((i * 7 + Math.floor(now / 300)) % 20)}px"></span>{/each}</div>
          <span class="t">{clock(now - job.startedAt)}</span>
          <button class="stop" onclick={stop}><i></i>Stop</button>
        </div>
      {:else if job.state === 'failed'}
        <h2>That one did not work</h2>
        <p class="note err">{job.error}</p>
        <button class="primary" onclick={() => (job = null)}>Back to meetings</button>
      {:else}
        <h2>{job.state === 'transcribing' ? 'Transcribing on this Mac…' : 'Writing the notes…'}</h2>
        <p class="note">This takes about a minute per ten minutes of meeting.</p>
      {/if}
    </div>
  </div>
{:else}
  <div class="page">
    <Header crumbs={[tabName]}>
      {#if canEditHere()}
        <button class="ghost" onclick={create}><Plus size={12} /><span>New meeting</span></button>
        <button class="primary" disabled={engine?.parakeet === false} onclick={() => start()}><i class="dot"></i><span>Transcribe</span></button>
      {/if}
    </Header>
    <div class="scroll">
      <div class="home">
        {#if engine && !engine.parakeet}
          <div class="model">
            <div class="mi"><Cpu size={17} /></div>
            <div class="mt">
              <span class="h">Download the transcription model</span>
              <span class="s">
                {engine.install.state === 'running'
                  ? 'Downloading and setting up Parakeet. This takes a few minutes the first time; you can keep working.'
                  : engine.install.state === 'failed'
                    ? 'The download did not finish. It needs Xcode command line tools (xcode-select --install); then try again.'
                    : 'Meetings are transcribed on this Mac by Parakeet, so audio never leaves it. One download, about 600 MB.'}
              </span>
              {#if engine.install.state === 'running'}<div class="prog"><i></i></div>{/if}
            </div>
            {#if engine.install.state !== 'running'}
              <button class="primary sm" onclick={download}>{engine.install.state === 'failed' ? 'Try again' : 'Download'}</button>
            {/if}
          </div>
        {/if}

        <section>
          <div class="sh">
            <span>Up next</span>
            <span class="src"><Calendar size={12} />Google Calendar via Composio</span>
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
            {#each upcoming.events as ev (ev.id)}
              <div class="event">
                <span class="bar"></span>
                <div class="et"><span class="h">{ev.title}</span><span class="s">{when(ev.start)}{ev.people ? ` · ${ev.people} people` : ''}</span></div>
                <span class="soon">{until(ev.start)}</span>
                <button class="primary sm" disabled={engine?.parakeet === false} onclick={() => start(ev.title)}><i class="dot"></i>Transcribe</button>
              </div>
            {/each}
          {/if}
        </section>

        <section>
          <div class="sh"><span>Meetings</span></div>
          {#each meetings as m (m.id)}
            <button class="row" onclick={() => go(tabId, m.id)} onmouseenter={() => prefetch(`/meetings/${m.id}`)}>
              <div class="date"><span>{day(m.startedAt).toLocaleDateString(undefined, { weekday: 'short' })}</span><b>{day(m.startedAt).getDate()}</b></div>
              <div class="rt"><span class="h">{m.title}</span><span class="s">{m.hasTranscript ? 'Transcript and notes' : m.status === 'failed' ? 'Transcription failed' : 'Notes'} · {ago(m.startedAt)}</span></div>
              <ProjectChip kind="meeting" id={m.id} project={m.project ?? null} onmoved={(p) => (meetings = meetings.map((x) => (x.id === m.id ? { ...x, project: p } : x)))} />
              <span class="d">{dur(m.durationS)}</span>
            </button>
          {:else}
            {#if loading}
              {#each [0, 1, 2] as _}<div class="row sk"><Skeleton w={32} h={30} r={6} /><div class="rt"><Skeleton w="50%" h={12} /><Skeleton w="30%" h={10} /></div></div>{/each}
            {:else}
              <p class="empty">
                {#if scope.enabled && scope.id}Nothing here yet. Meetings you record in this project land here; to move an existing one, switch to All projects and use its project chip.
                {:else}No meetings yet.{/if}
              </p>
            {/if}
          {/each}
        </section>
      </div>
    </div>
  </div>
{/if}

<style>
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
    font-size: 12px;
    font-weight: 400;
    color: var(--muted);
  }
  .connect {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 12px 14px;
    border-radius: 10px;
    border: 1px dashed #333;
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
    gap: 8px;
    height: 30px;
    padding: 0 12px;
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
    height: 28px;
    padding: 0 12px;
    border-radius: 6px;
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
  .recorder {
    position: fixed;
    left: calc(50% + 116px);
    bottom: 28px;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 8px 8px 8px 16px;
    border-radius: 14px;
    background: var(--raised);
    border: 1px solid var(--line-strong);
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.55);
  }
  .wave {
    display: flex;
    align-items: center;
    gap: 3px;
    height: 28px;
  }
  .wave span {
    width: 3px;
    border-radius: 2px;
    background: var(--ink-2);
    transition: height 0.3s;
  }
  .t {
    font-family: var(--mono);
    font-size: 13px;
    width: 48px;
  }
  .stop {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 36px;
    padding: 0 14px;
    border-radius: 9px;
    background: #e5484d;
    color: #fff;
    border: 0;
    font: inherit;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }
  .stop i {
    width: 10px;
    height: 10px;
    border-radius: 2px;
    background: #fff;
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
    gap: 18px;
    border-bottom: 1px solid var(--line);
    margin: 8px 0 4px;
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
    white-space: pre-wrap;
    font: inherit;
    font-size: 14px;
    line-height: 1.7;
    color: #d4d4d4;
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
