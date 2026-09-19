<script lang="ts">
  // A placeholder in the shape of what is coming.
  let { w = '100%', h = 12, r = 4 }: { w?: string | number; h?: number; r?: number } = $props()
</script>

<span class="sk" style:width={typeof w === 'number' ? `${w}px` : w} style:height="{h}px" style:border-radius="{r}px"></span>

<style>
  .sk {
    display: block;
    background: linear-gradient(90deg, var(--raised) 0%, var(--line-strong) 45%, var(--raised) 90%);
    background-size: 220% 100%;
    animation: shimmer 1.3s ease-in-out infinite;
  }
  @keyframes shimmer {
    from {
      background-position: 120% 0;
    }
    to {
      background-position: -120% 0;
    }
  }
</style>
