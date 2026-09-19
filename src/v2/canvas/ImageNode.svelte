<script lang="ts">
  import { NodeResizer, type NodeProps } from '@xyflow/svelte'
  import Handles from './Handles.svelte'
  import { workspace } from '../../lib/workspace.svelte'
  import { apiUrl } from '../../lib/session.svelte'
  let { data, selected }: NodeProps = $props()
  const d = $derived(data as { title?: string; imageUrl?: string })
  // Images a Cloudflare workspace serves come through this Mac, which holds its token.
  const src = $derived(
    d.imageUrl?.startsWith('/assets/') ? apiUrl(`/api/v2/asset?src=${encodeURIComponent(d.imageUrl)}&ws=${encodeURIComponent(workspace.activeId)}`) : d.imageUrl,
  )
</script>

<NodeResizer isVisible={selected} minWidth={80} minHeight={60} keepAspectRatio lineStyle="border-color:#ededed" handleStyle="background:#ededed;border:0" />
<Handles />
<div class="img" class:sel={selected}>
  {#if src}<img {src} alt={d.title ?? ''} draggable="false" />{/if}
</div>

<style>
  .img {
    width: 100%;
    height: 100%;
    border-radius: 8px;
    overflow: hidden;
    border: 1px solid #2a2a2a;
    background: #141414;
  }
  .sel {
    outline: 1.5px solid #ededed;
    outline-offset: 4px;
  }
  img {
    width: 100%;
    height: 100%;
    object-fit: contain;
    display: block;
  }
</style>
