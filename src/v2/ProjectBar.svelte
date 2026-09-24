<script lang="ts">
  // The project switcher, under the workspace. Only here when a workspace is
  // split into projects; "All projects" is the way back to everything.
  import ChevronsUpDown from '@lucide/svelte/icons/chevrons-up-down'
  import Check from '@lucide/svelte/icons/check'
  import Plus from '@lucide/svelte/icons/plus'
  import CircleDashed from '@lucide/svelte/icons/circle-dashed'
  import UserRound from '@lucide/svelte/icons/user-round'
  import { scope, activeProject, liveProjects, projectLabel, personalProject, NO_PROJECT } from './project.svelte'
  import { setProject, openSettings } from './state.svelte'

  let open = $state(false)
  const current = $derived(activeProject())
</script>

<div class="wrap">
  <button class="pbar" class:on={open} onclick={() => (open = !open)}>
    {#if current?.personal}<UserRound size={13} />{:else}<i class="dot {current?.color ?? 'all'}"></i>{/if}
    <span class="name">{projectLabel()}</span>
    <ChevronsUpDown size={13} />
  </button>

  {#if open}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="catch" onclick={() => (open = false)}></div>
    <div class="menu">
      {#if personalProject()}
        {@const mine = personalProject()!}
        <!-- Yours: a meeting or a doc that is not the team's goes here. -->
        <button class="row" onclick={() => ((open = false), setProject(mine.id))}>
          <UserRound size={13} /><span class="grow">Personal</span>
          {#if scope.id === mine.id}<Check size={13} />{/if}
        </button>
        <div class="line"></div>
      {/if}
      {#each liveProjects().filter((p) => !p.personal) as p (p.id)}
        <button class="row" onclick={() => ((open = false), setProject(p.id))}>
          <i class="dot {p.color}"></i>
          <span class="grow">{p.name}</span>
          {#if p.role === 'read'}<span class="role">Read only</span>{/if}
          {#if scope.id === p.id}<Check size={13} />{/if}
        </button>
      {:else}
        <span class="none">{scope.canManage ? 'No projects yet.' : 'You are not in a project yet. An admin can add you.'}</span>
      {/each}
      {#if scope.canManage}
        <div class="line"></div>
        <button class="row" onclick={() => ((open = false), setProject(NO_PROJECT))}>
          <CircleDashed size={13} /><span class="grow">Unfiled</span>
          {#if scope.id === NO_PROJECT}<Check size={13} />{/if}
        </button>
        <button class="row" onclick={() => ((open = false), openSettings('projects'))}><Plus size={13} /><span class="grow">New project</span></button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .wrap {
    position: relative;
  }
  button {
    font: inherit;
    color: inherit;
    background: none;
    border: 0;
    cursor: pointer;
    text-align: left;
  }
  .pbar {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    height: 30px;
    padding: 0 8px;
    border-radius: var(--r-md);
    color: var(--ink-2);
    font-size: var(--fs-2);
  }
  .pbar:hover,
  .pbar.on {
    background: var(--raised);
    color: var(--ink);
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .catch {
    position: fixed;
    inset: 0;
    z-index: 40;
  }
  .menu {
    position: absolute;
    top: 34px;
    left: 0;
    right: 0;
    z-index: 50;
    padding: 4px;
    border-radius: var(--r-lg);
    background: var(--panel);
    border: 1px solid var(--line-strong);
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.45);
    max-height: 320px;
    overflow: auto;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    height: 28px;
    padding: 0 8px;
    border-radius: var(--r-md);
    font-size: var(--fs-2);
    color: var(--ink-2);
  }
  .row:hover {
    background: var(--accent-soft);
    color: var(--ink);
  }
  .grow {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .role {
    font-size: var(--fs-1);
    color: var(--muted);
  }
  .none {
    display: block;
    padding: 8px;
    font-size: var(--fs-2);
    color: var(--muted);
    line-height: 1.45;
  }
  .line {
    height: 1px;
    margin: 4px 0;
    background: var(--line);
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
    background: var(--muted);
  }
  .dot.all {
    background: none;
    border: 1px solid var(--line-strong);
  }
  .dot.blue { background: #6aa6ff; }
  .dot.green { background: #6fcf97; }
  .dot.amber { background: #e7b75f; }
  .dot.rose { background: #f28ba8; }
  .dot.violet { background: #b38cf0; }
  .dot.teal { background: #5fd0c5; }
  .dot.orange { background: #f0955f; }
  .dot.slate { background: #8d97a8; }
</style>
