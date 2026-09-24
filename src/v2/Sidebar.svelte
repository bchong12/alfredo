<script lang="ts">
  // The left rail: the company at the top, the tabs in the middle, you at the
  // bottom. Everything else opens from one of those three.
  import ChevronsUpDown from '@lucide/svelte/icons/chevrons-up-down'
  import Search from '@lucide/svelte/icons/search'
  import Columns3 from '@lucide/svelte/icons/columns-3'
  import FileText from '@lucide/svelte/icons/file-text'
  import Shapes from '@lucide/svelte/icons/shapes'
  import Mic from '@lucide/svelte/icons/mic'
  import Package from '@lucide/svelte/icons/package'
  import WorkspaceMark from './WorkspaceMark.svelte'
  import ProjectBar from './ProjectBar.svelte'
  import Face from './Face.svelte'
  import ChevronRight from '@lucide/svelte/icons/chevron-right'
  import { ui, visibleTabs, go, openPack, packView, refreshWorkspace, refreshing } from './state.svelte'
  import { PACK_TABS } from './packs'
  import Download from '@lucide/svelte/icons/download'
  import RefreshCw from '@lucide/svelte/icons/refresh-cw'
  import { activeWorkspace, workspace } from '../lib/workspace.svelte'
  import { scope } from './project.svelte'
  import { brandOf } from './remembered.svelte'
  import { TAB_PATHS, prefetch } from './cache'

  let { onsearch }: { onsearch: () => void } = $props()

  const ws = $derived(activeWorkspace())
  let expanded = $state<Record<string, boolean>>({})
  const ICONS: Record<string, any> = { board: Columns3, docs: FileText, canvas: Shapes, meetings: Mic }
  const iconFor = (type: string) => ICONS[type] ?? PACK_TABS[type]?.icon ?? Package
  /** Fetch what a tab shows while the pointer is still on its way to it. */
  const warm = (type: string) => (TAB_PATHS[type] ?? []).forEach(prefetch)
</script>

<aside>
  <button class="switcher" class:open={ui.overlay === 'workspaces'} onclick={() => (ui.overlay = ui.overlay === 'workspaces' ? null : 'workspaces')}>
    <WorkspaceMark name={ui.settings?.name ?? brandOf(ws?.id ?? '').name ?? ws?.name ?? ''} logo={ui.settings?.logo ?? brandOf(ws?.id ?? '').logo ?? null} size={28} />
    <span class="wsname">{ui.settings?.name ?? brandOf(ws?.id ?? '').name ?? ws?.name ?? 'Workspace'}</span>
    <ChevronsUpDown size={14} />
  </button>

  {#if scope.enabled}<ProjectBar />{/if}

  <button class="search" onclick={onsearch}>
    <Search size={13} />
    <span>Search</span>
    <kbd>⌘K</kbd>
  </button>

  <nav>
    {#each visibleTabs() as t (t.id)}
      {@const Icon = iconFor(t.type)}
      {@const views = PACK_TABS[t.type]?.views ?? []}
      {#if views.length > 1}
        {@const open = ui.tab === t.id || expanded[t.id]}
        <button class="tab" class:on={ui.tab === t.id && !open} onclick={() => (expanded = { ...expanded, [t.id]: !open })}>
          <Icon size={14} />
          <span>{t.name}</span>
          <span class="chev" class:down={open}><ChevronRight size={12} /></span>
        </button>
        {#if open}
          {#each views as v (v.id)}
            <button class="tab sub" class:on={ui.tab === t.id && packView(t.type) === v.id} onclick={() => openPack(t.id, t.type, v.id)}>
              <span>{v.label}</span>
            </button>
          {/each}
        {/if}
      {:else}
        <button class="tab" class:on={ui.tab === t.id} onclick={() => go(t.id)} onmouseenter={() => warm(t.type)} onfocus={() => warm(t.type)}>
          <Icon size={14} />
          <span>{t.name}</span>
        </button>
      {/if}
    {/each}
  </nav>

  <div class="spacer"></div>

  <!-- Ask the database again for what is on screen. Quiet, and out of the way. -->
  <button class="refresh" class:busy={refreshing.busy} title="Refresh (⌘R)" aria-label="Refresh" onclick={() => void refreshWorkspace()}><RefreshCw size={13} /></button>

  {#if workspace.hosted}
    <!-- The site is the same workspace with less in it: nothing here records,
         reads in, or talks to an agent. Say so where the tabs end. -->
    <a class="getapp" href="https://github.com/bchong12/alfredo/releases/latest" target="_blank" rel="noopener">
      <span class="gettop"><Download size={13} /><b>Get the desktop app</b></span>
      <span class="getwhy">It is the better one: it records and transcribes meetings, answers questions from everything in here, and works with your AI through MCP. This site shows the same workspace without those.</span>
      <span class="getcta">Download for Mac, Windows or Linux</span>
    </a>
  {/if}

  <button class="account" class:open={ui.overlay === 'account'} onclick={() => (ui.overlay = ui.overlay === 'account' ? null : 'account')}>
    <Face person={ui.me} size={24} />
    <span class="wsname">{ui.me?.name ?? 'You'}</span>
    <ChevronsUpDown size={14} />
  </button>
</aside>

<style>
  aside {
    width: 232px;
    flex-shrink: 0;
    height: 100%;
    background: var(--panel);
    border-right: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 10px;
    box-sizing: border-box;
  }
  :global(html.desktop) aside {
    padding-top: 40px;
  }
  button {
    font: inherit;
    color: inherit;
    background: none;
    border: 0;
    cursor: pointer;
    text-align: left;
  }
  .switcher,
  .account {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 44px;
    padding: 0 8px;
    border-radius: var(--r-lg);
    color: var(--muted);
  }
  .switcher {
    border: 1px solid var(--line);
    background: var(--bg);
  }
  .refresh {
    align-self: flex-end;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    margin: 0 0 6px 0;
    border-radius: 7px;
    border: 1px solid var(--line);
    background: none;
    color: var(--muted);
    cursor: pointer;
  }
  .refresh:hover {
    color: var(--ink);
    border-color: var(--line-strong);
    background: var(--accent-soft);
  }
  .refresh.busy :global(svg) {
    animation: turn 0.9s linear infinite;
  }
  @keyframes turn {
    to {
      transform: rotate(360deg);
    }
  }
  .getapp {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 0 0 8px;
    padding: 10px 10px 11px;
    border: 1px solid var(--line);
    border-radius: var(--r-lg);
    background: var(--panel);
    color: var(--ink-2);
    text-decoration: none;
    font-size: var(--fs-1);
    line-height: 1.45;
  }
  .getapp:hover {
    border-color: var(--line-strong);
    color: var(--ink);
  }
  .gettop {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--ink);
    font-size: var(--fs-2);
  }
  .getwhy {
    color: var(--muted);
  }
  .getcta {
    color: var(--ink);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .switcher:hover,
  .switcher.open,
  .account:hover,
  .account.open {
    background: var(--raised);
  }
  .wsname {
    flex: 1;
    min-width: 0;
    color: var(--ink);
    font-size: var(--fs-3);
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .search {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 30px;
    padding: 0 8px;
    border: 1px solid var(--line);
    border-radius: var(--r-md);
    background: var(--bg);
    color: var(--muted);
    font-size: var(--fs-2);
  }
  .search span {
    flex: 1;
  }
  kbd {
    font-family: var(--mono);
    font-size: 11px;
  }
  nav {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .tab {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 28px;
    padding: 0 8px;
    border-radius: var(--r-md);
    font-size: var(--fs-3);
    color: var(--ink-2);
  }
  .tab:hover {
    background: var(--accent-soft);
  }
  .tab.on {
    background: var(--raised);
    color: var(--ink);
  }
  .tab span:not(.chev) {
    flex: 1;
  }
  .chev {
    display: flex;
    color: var(--muted);
    transition: transform 0.15s;
  }
  .chev.down {
    transform: rotate(90deg);
  }
  .sub {
    padding-left: 32px;
    font-size: var(--fs-2);
  }
  .spacer {
    flex: 1;
  }
  .account {
    height: 40px;
  }
</style>
