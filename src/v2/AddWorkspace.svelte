<script lang="ts">
  import ConnectDatabase from './ConnectDatabase.svelte'
  let { onclose }: { onclose: () => void } = $props()
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="scrim" onclick={onclose}>
  <div class="box" onclick={(e) => e.stopPropagation()}>
    <h2>Add a workspace</h2>
    <p>Each workspace has its own tabs, people and database.</p>
    <ConnectDatabase onconnected={onclose} />
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 75;
  }
  .box {
    width: 480px;
    max-height: calc(100vh - 80px);
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 24px;
    background: var(--panel);
    border: 1px solid var(--line-strong);
    border-radius: 12px;
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.6);
  }
  h2 {
    margin: 0;
    font-size: 20px;
    letter-spacing: -0.02em;
  }
  p {
    margin: 0 0 6px;
    font-size: 13px;
    color: var(--ink-2);
  }
</style>
