<script lang="ts">
  // A person: their photo when they have one, calm initials when not.
  import { initials, toneFor, type Person } from './api'
  let { person, size = 20, dim = false }: { person: Person | null; size?: number; dim?: boolean } = $props()
</script>

{#if person?.avatar}
  <img class="face" class:dim src={person.avatar} alt={person.name} title={person.name} style:width="{size}px" style:height="{size}px" />
{:else if person}
  <span
    class="face ini"
    class:dim
    title={person.name}
    style:width="{size}px"
    style:height="{size}px"
    style:font-size="{Math.max(8, Math.round(size * 0.42))}px"
    style:background={toneFor(person.name)}>{initials(person.name)}</span
  >
{:else}
  <span class="face none" style:width="{size}px" style:height="{size}px"></span>
{/if}

<style>
  .face {
    border-radius: 50%;
    flex-shrink: 0;
    object-fit: cover;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .ini {
    color: #15171a;
    font-weight: 600;
  }
  .none {
    border: 1.5px dashed var(--line-strong);
  }
  .dim {
    opacity: 0.6;
  }
</style>
