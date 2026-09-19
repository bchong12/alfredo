<script lang="ts">
  import Settings from '@lucide/svelte/icons/settings'
  import Moon from '@lucide/svelte/icons/moon'
  import Sun from '@lucide/svelte/icons/sun'
  import LogOut from '@lucide/svelte/icons/log-out'
  import { ui, openSettings } from './state.svelte'
  import { theme, toggleTheme, effectiveTheme } from '../lib/theme.svelte'
  import { auth, signOut } from '../lib/session.svelte'
  import { activeWorkspace } from '../lib/workspace.svelte'

  const dark = $derived(theme.mode === 'dark' || (theme.mode === 'system' && effectiveTheme() === 'dark'))
  const canSignOut = $derived(activeWorkspace()?.kind === 'remote' && !!auth.session)
</script>

<div class="menu" role="menu">
  <div class="who">
    <span class="name">{ui.me?.name ?? 'You'}</span>
    {#if ui.me?.email}<span class="sub">{ui.me.email}</span>{/if}
  </div>
  <button class="item" role="menuitem" onclick={() => openSettings('general')}><Settings size={14} /><span>Settings</span><kbd>⌘,</kbd></button>
  <button class="item" role="menuitem" onclick={toggleTheme}>
    {#if dark}<Moon size={14} />{:else}<Sun size={14} />{/if}<span>Appearance</span><span class="val">{dark ? 'Dark' : 'Light'}</span>
  </button>
  {#if canSignOut}
    <div class="sep"></div>
    <button
      class="item"
      role="menuitem"
      onclick={() => {
        ui.overlay = null
        signOut()
      }}><LogOut size={14} /><span>Sign out</span></button
    >
  {/if}
</div>

<style>
  .menu {
    position: absolute;
    left: 10px;
    bottom: 58px;
    width: 260px;
    z-index: 50;
    background: var(--raised);
    border: 1px solid var(--line-strong);
    border-radius: 10px;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6);
    padding: 6px;
    display: flex;
    flex-direction: column;
  }
  .who {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px 8px 10px;
    border-bottom: 1px solid var(--line-strong);
    margin-bottom: 4px;
  }
  .name {
    font-size: 13px;
    font-weight: 500;
  }
  .sub {
    font-size: 12px;
    color: var(--muted);
  }
  .item {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 32px;
    padding: 0 8px;
    border: 0;
    border-radius: var(--r-md);
    background: none;
    color: var(--ink-2);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
    text-align: left;
  }
  .item span:first-of-type {
    flex: 1;
  }
  .item:hover {
    background: #222;
    color: var(--ink);
  }
  kbd,
  .val {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
  }
  .sep {
    height: 1px;
    background: var(--line-strong);
    margin: 4px 0;
  }
</style>
