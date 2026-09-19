<script lang="ts">
  // Hands the parent the viewport controls, which only exist inside <SvelteFlow>.
  import { useSvelteFlow } from '@xyflow/svelte'
  let { onready }: { onready: (api: ReturnType<typeof useSvelteFlow>) => void } = $props()
  const api = useSvelteFlow()
  onready(api)
</script>
