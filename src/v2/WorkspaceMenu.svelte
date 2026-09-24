<script lang="ts">
  import Check from '@lucide/svelte/icons/check'
  import Plus from '@lucide/svelte/icons/plus'
  import Settings from '@lucide/svelte/icons/settings'
  import RefreshCw from '@lucide/svelte/icons/refresh-cw'
  import WorkspaceMark from './WorkspaceMark.svelte'
  import { workspace, pick } from '../lib/workspace.svelte'
  import { ui, openSettings } from './state.svelte'
  import { brandOf } from './remembered.svelte'

  let { onadd, onrefresh }: { onadd: () => void; onrefresh: () => void } = $props()

  const where = (k: string) => (k === 'remote' ? 'Supabase' : k === 'cloudflare' ? 'Cloudflare' : 'This Mac')
</script>

<div class="menu" role="menu">
  <div class="label">Workspaces</div>
  {#each workspace.list as w (w.id)}
    <button
      class="item"
      class:on={w.id === workspace.activeId}
      role="menuitem"
      onclick={() => {
        pick(w.id)
        ui.overlay = null
      }}
    >
      <WorkspaceMark name={brandOf(w.id).name ?? w.name} logo={(w.id === workspace.activeId ? ui.settings?.logo : null) ?? brandOf(w.id).logo ?? null} size={26} />
      <span class="meta"><span class="name">{brandOf(w.id).name ?? w.name}</span><span class="sub">{where(w.kind)}</span></span>
      {#if w.id === workspace.activeId}<Check size={14} />{/if}
    </button>
  {/each}
  <div class="sep"></div>
  <button class="item act" role="menuitem" onclick={onrefresh}><span class="ico"><RefreshCw size={14} /></span>Refresh<kbd>⌘R</kbd></button>
  {#if !workspace.hosted}<button class="item act" role="menuitem" onclick={onadd}><span class="ico"><Plus size={14} /></span>Add workspace</button>{/if}
  <button class="item act" role="menuitem" onclick={() => openSettings('general')}><span class="ico"><Settings size={14} /></span>Workspace settings</button>
</div>

<style>
  kbd {
    margin-left: auto;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
  }

  .menu {
    position: absolute;
    left: 10px;
    top: 60px;
    width: 300px;
    z-index: 50;
    background: var(--raised);
    border: 1px solid var(--line-strong);
    border-radius: 10px;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6);
    padding: 6px;
    display: flex;
    flex-direction: column;
  }
  :global(html.desktop) .menu {
    top: 90px;
  }
  .label {
    padding: 6px 8px 4px;
    font-size: 11px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted);
    font-weight: 500;
  }
  .item {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 40px;
    padding: 0 8px;
    border: 0;
    border-radius: var(--r-md);
    background: none;
    color: var(--ink-2);
    font: inherit;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }
  .item:hover,
  .item.on {
    background: var(--raised);
    color: var(--ink);
  }
  .meta {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .name {
    color: var(--ink);
    font-weight: 500;
  }
  .sub {
    font-size: 11px;
    color: var(--muted);
  }
  .act {
    min-height: 32px;
  }
  .ico {
    width: 26px;
    display: flex;
    justify-content: center;
  }
  .sep {
    height: 1px;
    background: var(--line-strong);
    margin: 6px 0;
  }
</style>
