<script lang="ts">
  // The very first frame, while the registry and the session are being read.
  // It is the app's own shape: the rail, the tabs, a page. Nothing moves when
  // the real thing arrives, so opening Alfredo looks like opening a window
  // rather than waiting for one.
  import Skeleton from './Skeleton.svelte'
  import PageSkeleton from './PageSkeleton.svelte'

  const remembered = (() => {
    try {
      return (localStorage.getItem('alfredo.v2.kind') as 'list' | 'board' | 'grid' | null) ?? 'board'
    } catch {
      return 'board' as const
    }
  })()
</script>

<div class="shell">
  <aside>
    <div class="ws"><Skeleton w={26} h={26} r={7} /><Skeleton w={96} h={12} /></div>
    <div class="find"><Skeleton w="100%" h={30} r={8} /></div>
    <div class="tabs">
      {#each [64, 52, 68, 76] as w}
        <div class="tab"><Skeleton w={15} h={15} r={4} /><Skeleton w={w} h={11} /></div>
      {/each}
    </div>
    <div class="grow"></div>
    <div class="me"><Skeleton w={24} h={24} r={12} /><Skeleton w={90} h={11} /></div>
  </aside>
  <main><PageSkeleton kind={remembered} /></main>
</div>

<style>
  .shell {
    height: 100vh;
    display: flex;
    background: var(--bg);
    color: var(--ink);
    overflow: hidden;
  }
  aside {
    width: 232px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 14px 12px;
    border-right: 1px solid var(--line);
    box-sizing: border-box;
  }
  .ws {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 40px;
    padding: 0 6px;
  }
  .find {
    padding: 0 2px;
  }
  .tabs {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .tab {
    display: flex;
    align-items: center;
    gap: 12px;
    height: 30px;
    padding: 0 10px;
  }
  .grow {
    flex: 1;
  }
  .me {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 36px;
    padding: 0 6px;
  }
  main {
    flex: 1;
    min-width: 0;
    height: 100%;
  }
</style>
