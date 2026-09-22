<script lang="ts">
  // Alfredo: one app, many workspaces, each in its own database. The shell
  // loads the registry, signs in where a workspace needs it, then draws the
  // workspace's own tabs from its settings.
  import Sidebar from './Sidebar.svelte'
  import WorkspaceMenu from './WorkspaceMenu.svelte'
  import AccountMenu from './AccountMenu.svelte'
  import SettingsModal from './SettingsModal.svelte'
  import Search from './Search.svelte'
  import AddWorkspace from './AddWorkspace.svelte'
  import Recorder from './Recorder.svelte'
  import { sync as syncRecording } from './recording.svelte'
  import BoardTab from './BoardTab.svelte'
  import DocsTab from './DocsTab.svelte'
  import CanvasTab from './CanvasTab.svelte'
  import MeetingsTab from './MeetingsTab.svelte'
  import { PACK_TABS } from './packs'
  import SignIn from './SignIn.svelte'
  import Welcome from './Welcome.svelte'
  import PageSkeleton from './PageSkeleton.svelte'
  import ShellSkeleton from './ShellSkeleton.svelte'
  import X from '@lucide/svelte/icons/x'
  import { untrack } from 'svelte'
  import { scope } from './project.svelte'
  import { ui, visibleTabs, loadWorkspaceState, openSettings, packView } from './state.svelte'
  import { workspace, activeWorkspace, loadWorkspaces } from '../lib/workspace.svelte'
  import { auth, boot } from '../lib/session.svelte'
  import { net } from './net.svelte'

  let searching = $state(false)
  let adding = $state(false)

  // Anything in flight for longer than a blink. Below that nobody needs telling.
  let slow = $state(false)
  $effect(() => {
    if (!net.busy) {
      slow = false
      return
    }
    const t = setTimeout(() => (slow = true), 280)
    return () => clearTimeout(t)
  })

  loadWorkspaces().then(() => boot())

  // Each workspace can sign in to its own Supabase project.
  let booted: string | null = null
  $effect(() => {
    const id = workspace.activeId
    if (!workspace.ready || !id || id === booted) return
    booted = id
    // The first load already booted for its workspace; any other (a switch, or
    // the first workspace made on a fresh install) needs its own session check.
    untrack(() => {
      if (auth.for !== id) boot()
    })
  })

  const ws = $derived(activeWorkspace())
  const needsLogin = $derived(ws?.kind === 'remote' && auth.ready && auth.for === workspace.activeId && !auth.session)
  const ready = $derived(workspace.ready && auth.ready)
  const email = $derived(auth.session?.user?.email ?? null)

  // Whenever the workspace (or who is signed in) changes, reload its settings.
  $effect(() => {
    const id = workspace.activeId
    const ok = ready && auth.for === id && !needsLogin
    const who = email
    // untrack: loading reads the state it also writes (settings, projects),
    // and a tracked read there would re-run this effect off its own writes.
    if (id && ok) untrack(() => (loadWorkspaceState(who), syncRecording()))
    else if (id && needsLogin) {
      // Nothing of the previous workspace stays on screen while this one asks who you are.
      ui.settings = null
      ui.me = null
    }
  })

  const tab = $derived(visibleTabs().find((t) => t.id === ui.tab) ?? visibleTabs()[0])

  // The shape of the page that is coming, so the wait looks like the thing
  // being waited for. Remembered, because the first frame happens before any
  // workspace has said which tabs it has.
  const KIND: Record<string, 'list' | 'board' | 'grid'> = { board: 'board', docs: 'list', meetings: 'list', canvas: 'grid' }
  let lastKind = $state<'list' | 'board' | 'grid'>(
    (() => {
      try {
        return (localStorage.getItem('alfredo.v2.kind') as 'list' | 'board' | 'grid' | null) ?? 'board'
      } catch {
        return 'board' as const
      }
    })(),
  )
  $effect(() => {
    const type = tab?.type
    if (!type) return
    const k = KIND[type] ?? 'list'
    untrack(() => {
      lastKind = k
      try {
        localStorage.setItem('alfredo.v2.kind', k)
      } catch {}
    })
  })

  function onkey(e: KeyboardEvent) {
    const mod = e.metaKey || e.ctrlKey
    if (mod && e.key === 'k') {
      e.preventDefault()
      searching = true
    } else if (mod && e.key === ',') {
      e.preventDefault()
      openSettings('general')
    } else if (e.key === 'Escape' && ui.overlay) {
      ui.overlay = null
    }
  }
</script>

<svelte:window onkeydown={onkey} />

{#if !ready && !(workspace.ready && !workspace.list.length)}
  <ShellSkeleton />
{:else if !workspace.list.length && !workspace.hosted}
  <Welcome />
{:else}
  <div class="shell">
    <Sidebar onsearch={() => (searching = true)} />
    <main>
      {#if slow}<div class="loading" aria-hidden="true"></div>{/if}
      {#if needsLogin}
        <SignIn />
      {:else if !ui.settings}
        <PageSkeleton kind={lastKind} />
      {:else if tab}
        {#key `${workspace.activeId}:${tab.id}:${scope.enabled ? (scope.id ?? 'all') : ''}`}
          {#if tab.type === 'board'}
            <BoardTab tabName={tab.name} columns={tab.columns} />
          {:else if tab.type === 'docs'}
            <DocsTab tabId={tab.id} tabName={tab.name} />
          {:else if tab.type === 'canvas'}
            <CanvasTab tabId={tab.id} tabName={tab.name} />
          {:else if tab.type === 'meetings'}
            <MeetingsTab tabId={tab.id} tabName={tab.name} />
          {:else if PACK_TABS[tab.type]}
            {@const Pack = PACK_TABS[tab.type].component}
            <Pack kind={tab.type} tabName={tab.name} view={packView(tab.type)} />
          {:else}
            <div class="missing">
              <b>{tab.name}</b>
              <span>This tab is a “{tab.type}” pack, which this copy of Alfredo doesn't include. Hide it in Settings, Tabs.</span>
            </div>
          {/if}
        {/key}
      {/if}
    </main>

    {#if ui.overlay === 'workspaces'}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="catch" onclick={() => (ui.overlay = null)}></div>
      <WorkspaceMenu
        onadd={() => {
          ui.overlay = null
          adding = true
        }}
      />
    {:else if ui.overlay === 'account'}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="catch" onclick={() => (ui.overlay = null)}></div>
      <AccountMenu />
    {:else if ui.overlay === 'settings' && ui.settings}
      {#key workspace.activeId}<SettingsModal />{/key}
    {/if}
    {#if searching}<Search onclose={() => (searching = false)} />{/if}
    {#if adding}<AddWorkspace onclose={() => (adding = false)} />{/if}
    <!-- Not while something has gone wrong: that is said in the same place. -->
    {#if !ui.error}<Recorder />{/if}
    {#if ui.error}
      <div class="toast">
        <span>{ui.error}</span>
        <button onclick={() => (ui.error = '')} aria-label="Dismiss"><X size={14} /></button>
      </div>
    {/if}
  </div>
{/if}

<style>
  .shell {
    height: 100vh;
    display: flex;
    background: var(--bg);
    color: var(--ink);
    position: relative;
    overflow: hidden;
  }
  main {
    flex: 1;
    min-width: 0;
    height: 100%;
    position: relative;
  }
  /* One line, at the top of whatever is on screen. It appears only when a call
     is taking long enough to notice, so it never flickers on a fast answer. */
  .loading {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 2px;
    z-index: 30;
    background: linear-gradient(90deg, transparent, var(--ink-2, #9a9a9a), transparent);
    background-size: 42% 100%;
    background-repeat: no-repeat;
    animation: sweep 1.1s ease-in-out infinite;
    opacity: 0.5;
    pointer-events: none;
  }
  @keyframes sweep {
    0% {
      background-position: -45% 0;
    }
    100% {
      background-position: 130% 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .loading {
      animation: none;
      background: var(--line-strong);
    }
  }
  .boot {
    height: 100vh;
    background: var(--bg);
  }
  .missing {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 48px 32px;
    color: var(--muted);
    font-size: var(--fs-3);
  }
  .missing b {
    color: var(--ink);
    font-weight: 500;
  }
  .catch {
    position: fixed;
    inset: 0;
    z-index: 40;
  }
  .toast {
    position: fixed;
    left: 50%;
    bottom: 24px;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 12px;
    max-width: 560px;
    padding: 10px 12px 10px 16px;
    border-radius: 9px;
    background: var(--raised);
    border: 1px solid var(--line-strong);
    box-shadow: 0 12px 35px rgba(0, 0, 0, 0.5);
    font-size: 13px;
    z-index: 90;
  }
  /* Whatever went wrong wrote this, and what went wrong is not always brief:
     a flex child will not shrink below its content unless it is told it may,
     and an unbroken line then leaves the box and crosses the screen. */
  .toast span {
    min-width: 0;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
    line-height: 1.5;
    max-height: 40vh;
    overflow-y: auto;
  }
  .toast button {
    flex: none;
    align-self: flex-start;
    background: none;
    border: 0;
    color: var(--muted);
    cursor: pointer;
    display: flex;
  }
</style>
