<script lang="ts">
  // Every side can start or end an arrow. Boards made elsewhere name their
  // handles (detail-top, detail-bottom…); an edge whose handle is missing is
  // silently dropped, so all of them exist on every node.
  import { Handle, Position } from '@xyflow/svelte'
</script>

<Handle type="target" position={Position.Left} />
<Handle type="source" position={Position.Right} />
<Handle id="detail-top" type="target" position={Position.Top} class="detail" />
<Handle id="detail-left" type="target" position={Position.Left} class="detail" />
<Handle id="detail-right" type="source" position={Position.Right} class="detail" />
<Handle id="detail-bottom" type="source" position={Position.Bottom} class="detail" />
