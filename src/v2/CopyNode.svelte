<script lang="ts">
  // Copy this node as Markdown for your own AI. The icon becomes a check for
  // a moment; there is no toast and no label.
  import Copy from '@lucide/svelte/icons/copy'
  import Check from '@lucide/svelte/icons/check'
  let { text, size = 12 }: { text: () => string; size?: number } = $props()
  let done = $state(false)
  let t: ReturnType<typeof setTimeout> | undefined

  async function copy(e: MouseEvent) {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(text())
      done = true
      clearTimeout(t)
      t = setTimeout(() => (done = false), 1400)
    } catch {}
  }
</script>

<button class="copy" class:done title="Copy node" aria-label="Copy node" onclick={copy} onkeydown={(e) => e.stopPropagation()}>
  {#if done}<Check size={size + 1} />{:else}<Copy {size} />{/if}
</button>

<style>
  .copy {
    width: 20px;
    height: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: 4px;
    background: none;
    color: #5a5a5a;
    cursor: pointer;
    flex-shrink: 0;
  }
  .copy:hover {
    color: var(--ink);
    background: var(--accent-soft);
  }
  .copy.done {
    color: var(--ink);
  }
</style>
