<script lang="ts">
  // A decision, sitting above the step it is in the way of: one line, the
  // question, and whose it is. Dashed, because it is not work, it is a gap.
  import { Handle, Position, type NodeProps } from '@xyflow/svelte'
  import Check from '@lucide/svelte/icons/check'
  import Face from '../../Face.svelte'
  import type { Person } from '../../api'
  import type { Decision } from './model'

  let { data }: NodeProps = $props()
  const d = $derived(data as { decision: Decision; owner: Person | null })
</script>

<Handle id="down" type="source" position={Position.Bottom} class="quiet" />

<div class="gate" class:settled={!!d.decision.answer} title={d.decision.answer ? `Settled: ${d.decision.answer}` : 'An open decision'}>
  <span class="mark">{#if d.decision.answer}<Check size={10} />{:else}?{/if}</span>
  <span class="q">{d.decision.question}</span>
  {#if d.owner}<Face person={d.owner} size={16} />{/if}
</div>

<style>
  .gate {
    width: 264px;
    height: 30px;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 9px;
    border-radius: var(--r-lg);
    border: 1px dashed #3a3a3a;
    background: var(--bg);
    font-family: inherit;
    font-size: 12px;
    color: var(--ink-2);
    cursor: pointer;
  }
  .gate:hover {
    border-color: var(--muted);
    color: var(--ink);
  }
  .gate.settled {
    color: var(--muted);
    border-color: var(--line-strong);
  }
  .mark {
    width: 14px;
    flex: none;
    display: flex;
    justify-content: center;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
  }
  .q {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
</style>
