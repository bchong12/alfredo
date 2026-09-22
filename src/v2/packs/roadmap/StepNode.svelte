<script lang="ts">
  // A step on the map, drawn as the board draws a card: a mono label, the
  // title, and a quiet row of who and where it stands. No colour but the one
  // green the app keeps for "this can go".
  import { Handle, Position, type NodeProps } from '@xyflow/svelte'
  import Check from '@lucide/svelte/icons/check'
  import Face from '../../Face.svelte'
  import type { Person } from '../../api'
  import type { Standing, Step } from './model'

  let { data }: NodeProps = $props()
  const d = $derived(data as { step: Step; n: number; at: Standing; owners: Person[]; due: string | null; canEdit: boolean; oncycle: (id: string) => void })
  const s = $derived(d.step)
  const words = $derived(
    d.at.kind === 'ready' ? 'Ready to start'
    : d.at.kind === 'doing' ? 'Under way'
    : d.at.kind === 'done' ? 'Done'
    : d.at.kind === 'decision' ? `Needs ${d.at.decisions.length === 1 ? 'a decision' : `${d.at.decisions.length} decisions`}`
    : `After ${d.at.steps.map((x) => x.title).join(', ')}`,
  )
</script>

<Handle type="target" position={Position.Left} />
<Handle type="source" position={Position.Right} />
<Handle id="top" type="target" position={Position.Top} class="quiet" />

<div class="card {d.at.kind}">
  <div class="top">
    <span class="ref">STEP {d.n}</span>
    <span class="grow"></span>
    {#if s.due}<span class="ref">{d.due}</span>{/if}
    <button
      class="tick {s.state} nodrag"
      disabled={!d.canEdit}
      title={s.state === 'todo' ? 'Mark as under way' : s.state === 'doing' ? 'Mark as done' : 'Back to not started'}
      aria-label="Progress"
      onclick={(e) => (e.stopPropagation(), d.oncycle(s.id))}
    >{#if s.state === 'done'}<Check size={10} />{:else if s.state === 'doing'}<i></i>{/if}</button>
  </div>
  <span class="title">{s.title}</span>
  <div class="meta">
    <span class="stand"><i></i>{words}</span>
    <span class="grow"></span>
    {#if d.owners.length}
      <span class="faces">{#each d.owners as p (p.id)}<Face person={p} size={20} dim={s.state === 'done'} />{/each}{#if s.undecided}<span class="q" title="Which of them is not settled yet">?</span>{/if}</span>
    {:else}
      <span class="nobody">Unassigned</span>
    {/if}
  </div>
</div>

<style>
  .card {
    width: 264px;
    height: 104px;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
    border-radius: var(--r-lg);
    background: var(--raised);
    border: 1px solid var(--line-strong);
    cursor: pointer;
    font-family: inherit;
    color: var(--ink);
  }
  .card:hover {
    border-color: #3a3a3a;
  }
  .card.done {
    background: none;
    border-color: var(--line);
  }
  .card.done .title {
    color: var(--muted);
  }
  .top,
  .meta {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .grow {
    flex: 1;
  }
  .ref {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
  }
  .title {
    flex: 1;
    font-size: 13px;
    font-weight: 500;
    line-height: 18px;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .stand {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    font-size: 12px;
    color: var(--muted);
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .stand i {
    width: 6px;
    height: 6px;
    flex: none;
    border-radius: 50%;
    background: var(--line-strong);
  }
  .ready .stand {
    color: var(--ink-2);
  }
  .ready .stand i {
    background: var(--running);
  }
  .doing .stand i {
    background: var(--ink-2);
  }
  .decision .stand i {
    background: none;
    border: 1px dashed var(--muted);
    box-sizing: border-box;
  }
  .faces {
    display: inline-flex;
    align-items: center;
    flex: none;
  }
  .faces :global(.face + .face) {
    margin-left: -5px;
    box-shadow: 0 0 0 2px var(--raised);
  }
  .q {
    width: 16px;
    height: 16px;
    margin-left: -4px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    background: var(--raised);
    border: 1px dashed var(--muted);
    box-sizing: border-box;
    font-size: 10px;
    color: var(--ink-2);
  }
  .nobody {
    font-size: 12px;
    color: var(--muted);
  }
  .tick {
    width: 16px;
    height: 16px;
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border-radius: 50%;
    border: 1.5px solid var(--muted);
    background: none;
    color: var(--on-accent);
    cursor: pointer;
  }
  .tick:hover:not(:disabled) {
    border-color: var(--ink);
  }
  .tick.doing i {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--ink-2);
  }
  .tick.done {
    background: var(--ink-2);
    border-color: var(--ink-2);
  }
  .tick:disabled {
    cursor: default;
  }
</style>
