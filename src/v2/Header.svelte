<script lang="ts">
  // The top bar of every tab: where you are, then that page's actions.
  import type { Snippet } from 'svelte'
  import { ui } from './state.svelte'
  import { activeWorkspace } from '../lib/workspace.svelte'

  type Crumb = string | { label: string; onclick: () => void }
  let { crumbs = [], children }: { crumbs?: Crumb[]; children?: Snippet } = $props()
  const ws = $derived(ui.settings?.name ?? activeWorkspace()?.name ?? '')
</script>

<div class="bar">
  <span class="c dim">{ws}</span>
  {#each crumbs as c, i}
    <span class="slash">/</span>
    {#if typeof c === 'string'}
      <span class="c" class:dim={i < crumbs.length - 1}>{c}</span>
    {:else}
      <button class="c dim link" onclick={c.onclick}>{c.label}</button>
    {/if}
  {/each}
  <span class="grow"></span>
  {@render children?.()}
</div>

<style>
  .bar {
    height: 44px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 16px 0 20px;
    border-bottom: 1px solid var(--line);
    font-size: 13px;
  }
  :global(html.desktop) .bar {
    -webkit-app-region: drag;
  }
  :global(html.desktop) .bar :global(button),
  :global(html.desktop) .bar :global(input) {
    -webkit-app-region: no-drag;
  }
  .c {
    white-space: nowrap;
  }
  .dim {
    color: var(--muted);
  }
  .slash {
    color: var(--line-strong);
  }
  .grow {
    flex: 1;
  }
  .link {
    background: none;
    border: 0;
    font: inherit;
    padding: 0;
    cursor: pointer;
  }
  .link:hover {
    color: var(--ink);
  }
</style>
