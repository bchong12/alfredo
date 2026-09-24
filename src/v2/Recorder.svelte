<script lang="ts">
  // The recorder, in the app's frame: there whichever tab you are on, so a
  // meeting can be stopped from the board, and what it becomes is announced
  // where you are rather than holding a page hostage while it is written.
  import X from '@lucide/svelte/icons/x'
  import { rec, recordingNow, writingUp, stopRecording, offerToRecord, waveAway, recordThisCall } from './recording.svelte'
  import { go, visibleTabs } from './state.svelte'

  let now = $state(Date.now())
  $effect(() => {
    if (!recordingNow()) return
    const t = setInterval(() => (now = Date.now()), 1000)
    return () => clearInterval(t)
  })
  const clock = (ms: number) => {
    const s = Math.max(0, Math.floor(ms / 1000))
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  }
  const meetingsTab = () => visibleTabs().find((t) => t.type === 'meetings')?.id
  function open() {
    const tab = meetingsTab()
    if (tab && rec.ready?.meetingId) go(tab, rec.ready.meetingId)
    rec.ready = null
  }
  // Said for a while, then it is just a meeting in the list.
  $effect(() => {
    if (!rec.ready) return
    const t = setTimeout(() => (rec.ready = null), 12_000)
    return () => clearTimeout(t)
  })
</script>

{#if recordingNow() && rec.ended}
  {@const job = recordingNow()!}
  <!-- The call this recording was for has ended: one button to finish it. -->
  <div class="pill">
    <span class="name">The call has ended. Stop and write “{rec.title || job.title || 'Meeting'}” up?</span>
    <button class="stop" onclick={stopRecording}><i></i>Stop</button>
    <button class="x" aria-label="Keep recording" title="Keep recording" onclick={() => (rec.ended = false)}><X size={13} /></button>
  </div>
{:else if recordingNow()}
  {@const job = recordingNow()!}
  <div class="pill">
    <button class="what" onclick={() => meetingsTab() && go(meetingsTab()!)} title="Go to the meeting">
      <span class="wave">{#each Array(12) as _, i}<i style:height="{5 + ((i * 7 + Math.floor(now / 300)) % 16)}px"></i>{/each}</span>
      <span class="name">{rec.title || job.title || 'Meeting'}</span>
      <span class="t">{clock(now - job.startedAt)}</span>
    </button>
    <button class="stop" onclick={stopRecording}><i></i>Stop</button>
  </div>
{:else if offerToRecord()}
  <div class="pill">
    <span class="name">{rec.call!.event ? `${rec.call!.event.title} is on${rec.call!.app !== 'A call' ? ` (${rec.call!.app})` : ''}` : rec.call!.app === 'A call' ? 'Something is using the microphone' : `${rec.call!.app} is running`}. Transcribe it?</span>
    <button class="rec" onclick={recordThisCall}><i class="dot"></i>Transcribe</button>
    <button class="x" aria-label="Not this one" title="Not this one" onclick={waveAway}><X size={13} /></button>
  </div>
{:else if rec.ready}
  <div class="pill quiet">
    <span class="name">“{rec.ready.title || 'Meeting'}” is written up</span>
    <button class="open" onclick={open}>Open</button>
    <button class="x" aria-label="Dismiss" onclick={() => (rec.ready = null)}><X size={13} /></button>
  </div>
{:else if writingUp().length}
  <div class="pill quiet">
    <i class="spin"></i>
    <span class="name">{writingUp()[0].state === 'transcribing' ? 'Transcribing' : 'Writing up'} “{writingUp()[0].title || 'Meeting'}”</span>
  </div>
{/if}

<style>
  .pill {
    position: fixed;
    left: calc(50% + 116px);
    bottom: 24px;
    transform: translateX(-50%);
    /* Under a dialog: it is part of the page, not something in the way of one. */
    z-index: 30;
    display: flex;
    align-items: center;
    gap: 10px;
    max-width: min(560px, calc(100vw - 300px));
    padding: 7px 7px 7px 14px;
    border-radius: 13px;
    background: var(--raised);
    border: 1px solid var(--line-strong);
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.45);
    font-size: 13px;
  }
  .pill.quiet {
    padding: 8px 12px 8px 14px;
    color: var(--ink-2);
  }
  .what {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
    background: none;
    border: 0;
    padding: 0;
    font: inherit;
    color: var(--ink);
    cursor: pointer;
  }
  .wave {
    display: flex;
    align-items: center;
    gap: 3px;
    height: 24px;
    flex: none;
  }
  .wave i {
    width: 3px;
    border-radius: 2px;
    background: var(--ink-2);
    transition: height 0.3s;
  }
  .name {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .t {
    font-family: var(--mono);
    font-variant-numeric: tabular-nums;
    color: var(--muted);
    flex: none;
  }
  .stop {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 32px;
    padding: 0 13px;
    flex: none;
    border-radius: 8px;
    background: #e5484d;
    color: #fff;
    border: 0;
    font: inherit;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }
  .stop i {
    width: 9px;
    height: 9px;
    border-radius: 2px;
    background: #fff;
  }
  .rec {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 32px;
    padding: 0 13px;
    flex: none;
    border-radius: 8px;
    background: var(--ink);
    color: var(--bg);
    border: 0;
    font: inherit;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }
  .rec .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #e5484d;
  }
  .open {
    height: 26px;
    padding: 0 10px;
    border-radius: 6px;
    border: 1px solid var(--line-strong);
    background: var(--bg);
    color: var(--ink);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .x {
    display: flex;
    background: none;
    border: 0;
    color: var(--muted);
    cursor: pointer;
    padding: 2px;
  }
  .spin {
    width: 12px;
    height: 12px;
    flex: none;
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
</style>
