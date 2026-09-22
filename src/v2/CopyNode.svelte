<script lang="ts">
  // Copy something for your own AI. Something with an address (a card, a doc,
  // a canvas, a meeting) can be copied two ways, and which one is wanted
  // depends on who is going to read it, so the button asks:
  //
  //   a link for MCP   what it is and the call that reads it. For an assistant
  //                    with Alfredo connected: it fetches the thing as it is
  //                    now, and an hour of meeting is three lines to paste.
  //   the content      the Markdown itself, for anything that cannot reach
  //                    Alfredo: another chat, an email, a doc.
  //
  // Something with no address (a block of SQL) is simply copied. The icon
  // becomes a check for a moment; there is no toast.
  import Copy from '@lucide/svelte/icons/copy'
  import Check from '@lucide/svelte/icons/check'
  import Link from '@lucide/svelte/icons/link'
  import FileText from '@lucide/svelte/icons/file-text'
  import { linkForMcp, type Kind } from './clip'
  let {
    text,
    size = 12,
    as,
    label = 'Copy for your AI',
  }: {
    text: () => string
    size?: number
    /** What this is, so it can be copied as a link as well as in full. */
    as?: { kind: Kind; id: string; title: string }
    label?: string
  } = $props()
  let done = $state(false)
  let open = $state(false)
  let at = $state({ left: 0, top: 0 })
  let button = $state<HTMLButtonElement | null>(null)
  let t: ReturnType<typeof setTimeout> | undefined
  const MENU_W = 248

  async function put(what: string) {
    open = false
    try {
      await navigator.clipboard.writeText(what)
      done = true
      clearTimeout(t)
      t = setTimeout(() => (done = false), 1400)
    } catch {}
  }

  function press(e: MouseEvent) {
    e.stopPropagation()
    e.preventDefault()
    if (!as) return void put(text())
    open = !open
    if (!open || !button) return
    const r = button.getBoundingClientRect()
    const height = 108
    at = {
      left: Math.max(8, Math.min(window.innerWidth - MENU_W - 8, r.right - MENU_W)),
      top: r.bottom + 6 + height > window.innerHeight - 8 ? Math.max(8, r.top - 6 - height) : r.bottom + 6,
    }
  }
  const pick = (e: MouseEvent, what: () => string) => (e.stopPropagation(), e.preventDefault(), put(what()))

  /** Out of whatever it sits in and onto the window, so nothing clips it. */
  function floated(node: HTMLElement) {
    document.body.appendChild(node)
    return { destroy: () => node.remove() }
  }
</script>

<svelte:window onkeydown={(e) => open && e.key === 'Escape' && (open = false)} onresize={() => (open = false)} />

<button class="copy" class:done class:open bind:this={button} title={label} aria-label={label} aria-haspopup={as ? 'menu' : undefined} aria-expanded={as ? open : undefined} onclick={press} onkeydown={(e) => e.stopPropagation()}>
  {#if done}<Check size={size + 1} />{:else}<Copy {size} />{/if}
</button>

{#if open && as}
  <div class="layer" use:floated>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="catch" onclick={(e) => (e.stopPropagation(), (open = false))} onwheel={() => (open = false)}></div>
    <div class="menu" role="menu" style:left="{at.left}px" style:top="{at.top}px" style:width="{MENU_W}px">
      <button role="menuitem" onclick={(e) => pick(e, () => linkForMcp(as!.kind, as!.id, as!.title))}>
        <Link size={14} />
        <span class="w"><span class="h">Copy link for MCP</span><span class="s">Your AI reads it live, through Alfredo</span></span>
      </button>
      <button role="menuitem" onclick={(e) => pick(e, text)}>
        <FileText size={14} />
        <span class="w"><span class="h">Copy content</span><span class="s">The Markdown, to paste anywhere</span></span>
      </button>
    </div>
  </div>
{/if}

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
  .copy:hover,
  .copy.open {
    color: var(--ink);
    background: var(--accent-soft);
  }
  .copy.done {
    color: var(--ink);
  }
  .layer {
    position: fixed;
    inset: 0;
    z-index: 95;
    color: var(--ink);
  }
  .catch {
    position: absolute;
    inset: 0;
  }
  .menu {
    position: fixed;
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    padding: 4px;
    border-radius: var(--r-lg);
    background: var(--panel);
    border: 1px solid var(--line-strong);
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.45);
  }
  .menu button {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 8px;
    border: 0;
    border-radius: var(--r-md);
    background: none;
    font: inherit;
    color: var(--ink-2);
    text-align: left;
    cursor: pointer;
  }
  .menu button :global(svg) {
    flex: none;
    margin-top: 2px;
  }
  .menu button:hover {
    background: var(--accent-soft);
    color: var(--ink);
  }
  .w {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .h {
    font-size: 13px;
  }
  .s {
    font-size: 11.5px;
    color: var(--muted);
  }
</style>
