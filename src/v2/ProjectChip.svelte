<script lang="ts">
  // The project an item is in, shown in lists and clickable: move it without
  // opening it. This is how work made before projects finds its home.
  import Check from '@lucide/svelte/icons/check'
  import { v2 } from './api'
  import { scope, liveProjects, NO_PROJECT } from './project.svelte'
  import { drop } from './cache'
  import { ui } from './state.svelte'

  let {
    kind,
    id,
    project = null,
    onmoved,
    passive = false,
  }: {
    kind: 'card' | 'doc' | 'canvas' | 'meeting'
    id: string
    project?: string | null
    onmoved?: (p: string | null) => void
    /** Says which project and nothing more: the row's own menu does the moving. */
    passive?: boolean
  } = $props()

  let open = $state(false)
  let busy = $state(false)
  // Inside one project every row would say the same name, so it shrinks to its dot.
  const compact = $derived(!!scope.id && scope.id !== NO_PROJECT)
  const current = $derived(scope.list.find((p) => p.id === project) ?? null)

  async function move(e: MouseEvent, next: string | null) {
    e.stopPropagation()
    open = false
    if (next === project) return
    busy = true
    try {
      await v2.post('/projects/assign', { kind, ids: [id], project: next })
      drop(`/${kind === 'canvas' ? 'canvases' : kind + 's'}`)
      drop('/cards')
      drop('/weeks')
      onmoved?.(next)
    } catch (err) {
      ui.error = (err as Error).message
    }
    busy = false
  }
</script>

{#if scope.enabled && passive}
  {#if current && !compact}<span class="chip still"><i class="d {current.color}"></i><span class="t">{current.name}</span></span>
  {:else if current}<i class="d {current.color}" title={current.name}></i>{/if}
{:else if scope.enabled}
  <span class="chip-wrap">
    <button
      class="chip"
      class:empty={!current}
      class:busy
      title={current ? `In ${current.name}` : 'In General'}
      onclick={(e) => (e.stopPropagation(), (open = !open))}
    >
      <i class="d {current?.color ?? 'none'}"></i>
      {#if !compact}<span class="t">{current?.name ?? 'General'}</span>{/if}
    </button>
    {#if open}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <span class="catch" onclick={(e) => (e.stopPropagation(), (open = false))}></span>
      <span class="menu">
        <button onclick={(e) => move(e, null)}><i class="d none"></i><span class="t">General</span>{#if !project}<Check size={12} />{/if}</button>
        {#each liveProjects() as p (p.id)}
          <button onclick={(e) => move(e, p.id)}><i class="d {p.color}"></i><span class="t">{p.name}</span>{#if project === p.id}<Check size={12} />{/if}</button>
        {/each}
      </span>
    {/if}
  </span>
{/if}

<style>
  .chip-wrap {
    position: relative;
    display: inline-flex;
  }
  button {
    font: inherit;
    color: inherit;
    background: none;
    border: 0;
    cursor: pointer;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    max-width: 130px;
    height: 20px;
    padding: 0 6px;
    border-radius: 999px;
    border: 1px solid transparent;
    font-size: var(--fs-1);
    color: var(--muted);
  }
  .chip:not(.still):hover {
    border-color: var(--line-strong);
    color: var(--ink);
  }
  .chip.still {
    padding-left: 0;
    cursor: inherit;
  }
  .chip.empty .t {
    opacity: 0.65;
  }
  .chip.busy {
    opacity: 0.5;
  }
  .t {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .catch {
    position: fixed;
    inset: 0;
    z-index: 60;
  }
  .menu {
    position: absolute;
    top: 24px;
    right: 0;
    z-index: 70;
    display: flex;
    flex-direction: column;
    min-width: 160px;
    padding: 4px;
    border-radius: var(--r-lg);
    background: var(--panel);
    border: 1px solid var(--line-strong);
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.45);
  }
  .menu button {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 28px;
    padding: 0 8px;
    border-radius: var(--r-md);
    font-size: var(--fs-2);
    color: var(--ink-2);
    text-align: left;
  }
  .menu button:hover {
    background: var(--accent-soft);
    color: var(--ink);
  }
  .menu .t {
    flex: 1;
  }
  .d {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
    background: var(--muted);
  }
  .d.none {
    background: none;
    border: 1px dashed var(--line-strong);
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
