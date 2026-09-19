<script lang="ts">
  // Frames. A Miro page is a sheet with its name above it and a caption rule
  // inside; a plain frame is a dashed region with its name above.
  import { NodeResizer, type NodeProps } from '@xyflow/svelte'
  import Handles from './Handles.svelte'
  let { data, selected }: NodeProps = $props()
  const d = $derived(data as { title?: string; body?: string; variant?: string })
  const page = $derived(d.variant === 'miro-page')
</script>

<NodeResizer isVisible={selected} minWidth={200} minHeight={120} lineStyle="border-color:#ededed" handleStyle="background:#ededed;border:0" />
<Handles />
<div class="frame" class:page class:sel={selected}>
  <div class="label">
    <span>{d.title ?? 'Frame'}</span>
    {#if d.body && !page}<small>{d.body}</small>{/if}
  </div>
  {#if page && d.body}
    <div class="caption"><strong>{d.body}</strong><i></i></div>
  {/if}
</div>

<style>
  .frame {
    width: 100%;
    height: 100%;
    box-sizing: border-box;
    position: relative;
    border: 1.5px dashed #333;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.015);
  }
  .frame.page {
    border: 1px solid #262626;
    border-style: solid;
    border-radius: 2px;
    background: #141414;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
  }
  .sel {
    border-color: #ededed;
  }
  .label {
    position: absolute;
    left: 0;
    bottom: calc(100% + 12px);
    display: flex;
    align-items: baseline;
    gap: 12px;
    white-space: nowrap;
  }
  .label span {
    font-size: 23px;
    font-weight: 700;
    letter-spacing: -0.035em;
    color: #d4d4d4;
  }
  .page .label span {
    font-size: 37px;
    font-weight: 400;
    color: #8a8a8a;
  }
  .label small {
    font-size: 12px;
    color: #7e7e7e;
  }
  .caption {
    position: absolute;
    top: 35px;
    left: 42px;
    right: 42px;
    display: flex;
    flex-direction: column;
    gap: 15px;
  }
  .caption strong {
    font-size: 28px;
    line-height: 1.25;
    font-weight: 700;
    color: #ededed;
  }
  .caption i {
    display: block;
    height: 2px;
    width: 62%;
    max-width: 1050px;
    background: #4a4a4a;
  }
</style>
