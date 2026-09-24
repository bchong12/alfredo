<script lang="ts">
  // The three dots on a doc, a meeting or a canvas in a list: everything you
  // do TO a piece of work without opening it.
  //
  // Built the way file menus are built everywhere (Sketch, Framer, Height,
  // Felt): the menu floats over the whole window rather than living inside the
  // card, because a card clips what is inside it and a canvas tile cut this
  // menu off after its first row; "Move to project" is a row with the projects
  // beside it, the current one ticked, and picking one takes effect there and
  // then; Delete is last, apart, and red.
  import Ellipsis from '@lucide/svelte/icons/ellipsis'
  import Check from '@lucide/svelte/icons/check'
  import ChevronRight from '@lucide/svelte/icons/chevron-right'
  import FolderInput from '@lucide/svelte/icons/folder-input'
  import Trash2 from '@lucide/svelte/icons/trash-2'
  import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right'
  import { v2 } from './api'
  import { scope, liveProjects } from './project.svelte'
  import { dropEverywhere } from './cache'
  import { ui } from './state.svelte'

  let {
    kind,
    id,
    project = null,
    onopen,
    onmoved,
    ondelete,
  }: {
    kind: 'doc' | 'canvas' | 'meeting'
    id: string
    project?: string | null
    onopen?: () => void
    onmoved?: (p: string | null) => void
    ondelete?: () => void
  } = $props()

  let open = $state(false)
  let moving = $state(false)
  let at = $state({ left: 0, top: 0 })
  let side = $state<'right' | 'left'>('right')
  let dots = $state<HTMLButtonElement | null>(null)

  const MENU_W = 208
  const SUB_W = 200

  function place() {
    if (!dots) return
    const r = dots.getBoundingClientRect()
    const rows = (onopen ? 1 : 0) + (scope.enabled ? 1 : 0) + (ondelete ? 1 : 0)
    const height = rows * 30 + 22
    // Under the dots and ending where they end; above them near the bottom.
    const left = Math.max(8, Math.min(window.innerWidth - MENU_W - 8, r.right - MENU_W))
    const top = r.bottom + 6 + height > window.innerHeight - 8 ? Math.max(8, r.top - 6 - height) : r.bottom + 6
    at = { left, top }
    side = left + MENU_W + SUB_W + 8 > window.innerWidth ? 'left' : 'right'
  }

  function toggle(e: MouseEvent) {
    e.stopPropagation()
    e.preventDefault()
    open = !open
    moving = false
    if (open) place()
  }
  const close = () => ((open = false), (moving = false))
  const act = (e: MouseEvent, fn?: () => void) => {
    e.stopPropagation()
    e.preventDefault()
    close()
    fn?.()
  }

  async function move(next: string | null) {
    if (next === (project ?? null)) return
    const was = project ?? null
    const lists = `/${kind === 'canvas' ? 'canvases' : kind + 's'}`
    // At once: the list shows where it is now, and the server is told behind it.
    onmoved?.(next)
    dropEverywhere(lists)
    try {
      await v2.post('/projects/assign', { kind, ids: [id], project: next })
      // Every project's copy of the list is one short or one long now.
      dropEverywhere(lists)
    } catch (err) {
      onmoved?.(was)
      ui.error = (err as Error).message
    }
  }

  /** Out of the card and onto the window, so nothing can clip it. */
  function floated(node: HTMLElement) {
    document.body.appendChild(node)
    return { destroy: () => node.remove() }
  }
</script>

<svelte:window onkeydown={(e) => open && e.key === 'Escape' && close()} onresize={() => open && close()} />

<span class="wrap" class:open>
  <button class="dots" bind:this={dots} aria-label="More" aria-haspopup="menu" aria-expanded={open} onclick={toggle}><Ellipsis size={15} /></button>
</span>

{#if open}
  <div class="layer" use:floated>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="catch" onclick={(e) => act(e)} oncontextmenu={(e) => act(e)} onwheel={close}></div>
    <div class="menu" role="menu" style:left="{at.left}px" style:top="{at.top}px" style:width="{MENU_W}px">
      {#if onopen}
        <button role="menuitem" onmouseenter={() => (moving = false)} onclick={(e) => act(e, onopen)}><ArrowUpRight size={14} /><span class="t">Open</span></button>
      {/if}
      {#if scope.enabled}
        <div class="has-sub">
          <button
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={moving}
            class:on={moving}
            onmouseenter={() => (moving = true)}
            onclick={(e) => (e.stopPropagation(), e.preventDefault(), (moving = !moving))}
          >
            <FolderInput size={14} /><span class="t">Move to project</span><ChevronRight size={13} />
          </button>
          {#if moving}
            <div class="menu sub {side}" role="menu" style:width="{SUB_W}px">
              {#each liveProjects() as p (p.id)}
                <button role="menuitemradio" aria-checked={project === p.id} onclick={(e) => act(e, () => move(p.id))}>
                  <i class="d {p.color}"></i><span class="t">{p.name}</span>{#if project === p.id}<Check size={13} />{/if}
                </button>
              {:else}
                <span class="nothing">No projects yet. Make one in Settings.</span>
              {/each}
              {#if liveProjects().length}<span class="rule"></span>{/if}
              <button role="menuitemradio" aria-checked={!project} onclick={(e) => act(e, () => move(null))}>
                <i class="d none"></i><span class="t">General</span>{#if !project}<Check size={13} />{/if}
              </button>
            </div>
          {/if}
        </div>
      {/if}
      {#if ondelete}
        <span class="rule"></span>
        <button class="danger" role="menuitem" onmouseenter={() => (moving = false)} onclick={(e) => act(e, ondelete)}><Trash2 size={14} /><span class="t">Delete</span></button>
      {/if}
    </div>
  </div>
{/if}

<style>
  .wrap {
    display: inline-flex;
    flex: none;
  }
  button {
    font: inherit;
    color: inherit;
    background: none;
    border: 0;
    cursor: pointer;
  }
  .dots {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border-radius: 6px;
    color: var(--muted);
  }
  .dots:hover,
  .wrap.open .dots {
    background: var(--line);
    color: var(--ink);
  }
  .layer {
    position: fixed;
    inset: 0;
    z-index: 95;
    font-size: 13px;
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
  .has-sub {
    position: relative;
    display: flex;
    flex-direction: column;
  }
  .menu.sub {
    position: absolute;
    top: -5px;
  }
  .menu.sub.right {
    left: calc(100% + 2px);
  }
  .menu.sub.left {
    right: calc(100% + 2px);
  }
  .menu button {
    display: flex;
    align-items: center;
    gap: 9px;
    height: 30px;
    padding: 0 8px;
    border-radius: var(--r-md);
    color: var(--ink-2);
    text-align: left;
  }
  .menu button:hover,
  .menu button.on {
    background: var(--accent-soft);
    color: var(--ink);
  }
  .menu .danger:hover {
    color: var(--danger);
  }
  .t {
    flex: 1;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .nothing {
    padding: 8px;
    color: var(--muted);
    font-size: 12px;
    line-height: 1.4;
  }
  .rule {
    height: 1px;
    margin: 4px 0;
    background: var(--line);
  }
  .d {
    width: 8px;
    height: 8px;
    margin: 0 3px;
    border-radius: 50%;
    flex-shrink: 0;
    background: var(--muted);
  }
  .d.none {
    background: none;
    border: 1px dashed var(--line-strong);
    box-sizing: border-box;
  }
  .d.blue { background: #6aa6ff; }
  .d.green { background: #6fcf97; }
  .d.amber { background: #e7b75f; }
  .d.rose { background: #f28ba8; }
  .d.violet { background: #b38cf0; }
  .d.teal { background: #5fd0c5; }
  .d.orange { background: #f0955f; }
  .d.slate { background: #8d97a8; }
</style>
