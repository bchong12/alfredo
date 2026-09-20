<script lang="ts">
  // What a page looks like before it has anything to say: the shape of the
  // page, greyed. Better than an empty rectangle, because the layout does not
  // jump when the answer arrives, and better than a spinner, because it says
  // what is coming.
  import Skeleton from './Skeleton.svelte'

  let { kind = 'list' }: { kind?: 'list' | 'board' | 'grid' } = $props()
</script>

<div class="page">
  <div class="bar">
    <Skeleton w={130} h={12} />
    <span class="grow"></span>
    <Skeleton w={84} h={26} r={7} />
  </div>
  <div class="body" class:board={kind === 'board'}>
    {#if kind === 'board'}
      {#each [0, 1, 2, 3] as col}
        <div class="col">
          <div class="ch"><Skeleton w={78} h={11} /></div>
          {#each Array(3 - (col % 2)) as _}
            <div class="card"><Skeleton w="72%" h={12} /><Skeleton w="45%" h={10} /></div>
          {/each}
        </div>
      {/each}
    {:else if kind === 'grid'}
      <Skeleton w={190} h={30} r={6} />
      <div class="grid">
        {#each Array(6) as _}
          <div class="tile"><Skeleton w="65%" h={12} /><Skeleton w="35%" h={10} /></div>
        {/each}
      </div>
    {:else}
      <Skeleton w={190} h={30} r={6} />
      <div class="rows">
        {#each Array(6) as _, i}
          <div class="row"><Skeleton w={14} h={14} r={4} /><Skeleton w="{46 - i * 4}%" h={12} /><span class="grow"></span><Skeleton w={54} h={10} /></div>
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  .page {
    height: 100%;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 44px;
    flex-shrink: 0;
    padding: 0 16px;
    border-bottom: 1px solid var(--line);
  }
  .grow {
    flex: 1;
  }
  .body {
    flex: 1;
    min-height: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    gap: 22px;
    padding: 44px 48px;
    max-width: 1040px;
    width: 100%;
    margin: 0 auto;
    box-sizing: border-box;
  }
  .body.board {
    flex-direction: row;
    max-width: none;
    margin: 0;
    gap: 16px;
    padding: 18px 16px;
  }
  .col {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }
  .ch {
    height: 28px;
    display: flex;
    align-items: center;
  }
  .card {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
    border-radius: 10px;
    border: 1px solid var(--line);
  }
  .rows {
    display: flex;
    flex-direction: column;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 38px;
    border-bottom: 1px solid var(--line);
  }
  .grid {
    display: flex;
    flex-wrap: wrap;
    gap: 14px;
  }
  .tile {
    width: 220px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 14px;
    border-radius: 10px;
    border: 1px solid var(--line);
  }
</style>
