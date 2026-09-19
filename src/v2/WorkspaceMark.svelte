<script lang="ts">
  // The company's logo when it has uploaded one; otherwise its initial.
  let { name, logo = null, size = 28 }: { name: string; logo?: string | null; size?: number } = $props()
</script>

{#if logo}
  <img class="mark" src={logo} alt={name} style:width="{size}px" style:height="{size}px" />
{:else}
  <span class="mark ini" style:width="{size}px" style:height="{size}px" style:font-size="{Math.round(size * 0.42)}px">{name.slice(0, 1).toUpperCase()}</span>
{/if}

<style>
  .mark {
    border-radius: 7px;
    flex-shrink: 0;
    object-fit: cover;
  }
  .ini {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: var(--line-strong);
    color: var(--ink);
    font-weight: 600;
  }
</style>
