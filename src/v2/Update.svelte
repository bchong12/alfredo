<script lang="ts">
  // "Alfredo 0.1.2 is ready": one line and one button, where the recorder sits.
  import X from '@lucide/svelte/icons/x'
  import { update, installUpdate } from './updates.svelte'
</script>

{#if update.version && !update.dismissed}
  <div class="pill">
    <span class="name">Alfredo {update.version} is ready.</span>
    <button class="go" onclick={installUpdate}>Restart to update</button>
    <button class="x" aria-label="Later" title="Later" onclick={() => (update.dismissed = true)}><X size={13} /></button>
  </div>
{/if}

<style>
  .pill {
    position: fixed;
    left: calc(50% + 116px);
    bottom: 24px;
    transform: translateX(-50%);
    z-index: 31;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 7px 7px 14px;
    border-radius: 13px;
    background: var(--raised);
    border: 1px solid var(--line-strong);
    box-shadow: var(--shadow-md);
    font-size: 13px;
    color: var(--ink);
  }
  .go {
    height: 32px;
    padding: 0 13px;
    border-radius: 8px;
    background: var(--ink);
    color: var(--bg);
    border: 0;
    font: inherit;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }
  .x {
    display: flex;
    background: none;
    border: 0;
    color: var(--muted);
    cursor: pointer;
    padding: 4px;
  }
</style>
