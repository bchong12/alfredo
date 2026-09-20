<script lang="ts">
  // Which project one card, doc, canvas or meeting belongs to. Only shown
  // when the workspace uses projects.
  import Select from './Select.svelte'
  import { v2, type InProject } from './api'
  import { scope, liveProjects } from './project.svelte'
  import { drop } from './cache'
  import { ui } from './state.svelte'

  let {
    kind,
    id,
    project = null,
    onchange,
    label = false,
  }: { kind: 'card' | 'doc' | 'canvas' | 'meeting'; id: string; project?: string | null; onchange?: (p: string | null) => void; label?: boolean } = $props()

  // Optimistic while the move is in flight, back to the prop after.
  let moved = $state<{ to: string | null } | null>(null)
  const value = $derived(moved ? moved.to : project)

  async function move(next: string | null) {
    moved = { to: next }
    onchange?.(next)
    try {
      await v2.post('/projects/assign', { kind, ids: [id], project: next })
      // The lists this item was in are a project short or a project long now.
      drop(`/${kind === 'canvas' ? 'canvases' : kind + 's'}`)
      drop('/cards')
      drop('/weeks')
      moved = null
    } catch (e) {
      moved = null
      onchange?.(project ?? null)
      ui.error = (e as Error).message
    }
  }
</script>

{#if scope.enabled}
  <label class="pick">
    {#if label}<span>Project</span>{/if}
    <Select
      value={value ?? ''}
      options={[{ value: '', label: 'No project', dot: 'none' }, ...liveProjects().map((p) => ({ value: p.id, label: p.name, dot: p.color }))]}
      onchange={(v) => move(v || null)}
      ariaLabel="Project"
    />
  </label>
{/if}

<style>
  .pick {
    display: flex;
    flex-direction: column;
    gap: 5px;
    font-size: var(--fs-1);
    color: var(--muted);
    min-width: 0;
  }
</style>
