<script lang="ts">
  // Copy something as Markdown for your own AI. With `as`, what lands on the
  // clipboard also names the workspace and the MCP call that reads it again,
  // so an assistant can follow it rather than just read it. The icon becomes a
  // check for a moment; there is no toast and no label.
  import Copy from '@lucide/svelte/icons/copy'
  import Check from '@lucide/svelte/icons/check'
  import { forClaude, type Kind } from './clip'
  let {
    text,
    size = 12,
    as,
    label = 'Copy for your AI',
  }: {
    text: () => string
    size?: number
    /** What this is, so the copy carries a handle back to it. */
    as?: { kind: Kind; id: string; title: string }
    label?: string
  } = $props()
  let done = $state(false)
  let t: ReturnType<typeof setTimeout> | undefined

  async function copy(e: MouseEvent) {
    e.stopPropagation()
    try {
      const body = text()
      await navigator.clipboard.writeText(as ? forClaude(as.kind, as.id, as.title, body) : body)
      done = true
      clearTimeout(t)
      t = setTimeout(() => (done = false), 1400)
    } catch {}
  }
</script>

<button class="copy" class:done title={label} aria-label={label} onclick={copy} onkeydown={(e) => e.stopPropagation()}>
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
