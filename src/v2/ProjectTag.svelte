<script lang="ts">
  // A project's dot and name, for lists seen across all projects.
  import { scope } from './project.svelte'
  let { project = null, dotOnly = false }: { project?: string | null; dotOnly?: boolean } = $props()
  const p = $derived(scope.list.find((x) => x.id === project) ?? null)
</script>

{#if scope.enabled && !scope.id && p}
  <span class="tag" title={p.name}><i class="d {p.color}"></i>{#if !dotOnly}<span>{p.name}</span>{/if}</span>
{/if}

<style>
  .tag {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    max-width: 140px;
    font-size: var(--fs-1);
    color: var(--muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .d {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
    background: var(--muted);
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
