<script lang="ts">
  // Board: one cycle at a time (a week, unless the workspace says otherwise).
  // Everything is instant: cycles draw from cache and the neighbours are
  // prefetched; edits show before the server answers and undo if it refuses.
  import { canEditHere, scope } from './project.svelte'
  import ProjectChip from './ProjectChip.svelte'
  import { dndzone, type DndEvent } from 'svelte-dnd-action'
  import { fly } from 'svelte/transition'
  import Plus from '@lucide/svelte/icons/plus'
  import Link from '@lucide/svelte/icons/link'
  import ChevronLeft from '@lucide/svelte/icons/chevron-left'
  import ChevronRight from '@lucide/svelte/icons/chevron-right'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import ArrowRight from '@lucide/svelte/icons/arrow-right'
  import Inbox from '@lucide/svelte/icons/inbox'
  import Settings2 from '@lucide/svelte/icons/settings-2'
  import CircleCheck from '@lucide/svelte/icons/circle-check'
  import Header from './Header.svelte'
  import CopyNode from './CopyNode.svelte'
  import Face from './Face.svelte'
  import Skeleton from './Skeleton.svelte'
  import CardDetail from './CardDetail.svelte'
  import { v2, STATUSES, weekRange, type Card, type Status, type CyclesView } from './api'
  import { peek, load as fetchCached, put, prefetch, drop } from './cache'
  import { ui, openSettings } from './state.svelte'
  import { manyForClaude } from './clip'
  import { takeFocus } from './focus'

  let { tabName = 'Board', columns }: { tabName?: string; columns?: string[] } = $props()

  const cardsPath = (w: string) => `/cards?week=${encodeURIComponent(w)}`

  let view = $state<CyclesView | null>(peek<CyclesView>('/weeks') ?? null)
  let week = $state<string>('')
  let cards = $state<Card[] | null>(null)
  let dir = $state(1)
  let menu = $state(false)
  let completing = $state(false)
  let open = $state<Card | null>(null)
  let adding = $state<Status | null>(null)
  let draft = $state('')
  let lists = $state<Record<Status, Card[]>>({ todo: [], progress: [], review: [], done: [] })

  const cycle = $derived(view?.cycles.find((c) => c.start === week) ?? null)
  const openHere = $derived((cards ?? []).filter((c) => c.status !== 'done').length)
  const label = (i: number) => columns?.[i] ?? STATUSES[i].label
  const len = $derived(view?.settings.length ?? 1)
  const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const shift = (start: string, n: number) => {
    const d = new Date(`${start}T00:00:00`)
    d.setDate(d.getDate() + 7 * len * n)
    return ymd(d)
  }
  const endOf = (start: string) => {
    const d = new Date(`${start}T00:00:00`)
    d.setDate(d.getDate() + 7 * len - 1)
    return ymd(d)
  }
  const cycleName = (start: string) => view?.cycles.find((c) => c.start === start)?.label ?? (len === 1 ? 'Week' : 'Cycle')

  function spread(list: Card[]) {
    const next: Record<Status, Card[]> = { todo: [], progress: [], review: [], done: [] }
    for (const c of [...list].sort((a, b) => a.position - b.position)) next[c.status].push(c)
    lists = next
  }
  function set(list: Card[]) {
    cards = list
    put(cardsPath(week), list)
    spread(list)
  }

  async function refreshView() {
    try {
      view = await fetchCached<CyclesView>('/weeks')
    } catch (e) {
      ui.error = (e as Error).message
    }
  }

  /** Show a cycle: from memory at once when we have it, skeletons when not. */
  async function show(w: string, d = 0) {
    dir = d
    week = w
    menu = false
    completing = false
    try {
      localStorage.setItem('alfredo.v2.week', w)
    } catch {}
    const cached = peek<Card[]>(cardsPath(w))
    cards = cached ?? null
    if (cached) spread(cached)
    try {
      const fresh = await fetchCached<Card[]>(cardsPath(w))
      if (week === w) {
        cards = fresh
        spread(fresh)
      }
    } catch (e) {
      ui.error = (e as Error).message
    }
    if (w !== 'backlog') {
      prefetch(cardsPath(shift(w, 1)))
      prefetch(cardsPath(shift(w, -1)))
    }
  }

  // Start on the current cycle, or where you were if that is this cycle or later.
  ;(async () => {
    if (!view) await refreshView()
    else refreshView()
    let saved = ''
    try {
      saved = localStorage.getItem('alfredo.v2.week') ?? ''
    } catch {}
    const cur = view?.current ?? ''
    show(saved === 'backlog' || (saved && saved >= cur && view?.cycles.some((c) => c.start === saved)) ? saved : cur)
  })()

  // --- writes, optimistic -----------------------------------------------------------
  async function patch(id: string, p: Record<string, unknown>, local: Partial<Card>) {
    const before = cards ?? []
    const moved = local.week !== undefined && local.week !== (week === 'backlog' ? null : week)
    set(moved ? before.filter((c) => c.id !== id) : before.map((c) => (c.id === id ? { ...c, ...local } : c)))
    try {
      const updated = await v2.patch<Card>(`/cards/${id}`, p)
      if (!moved && cards) set(cards.map((c) => (c.id === id ? { ...updated, position: c.position } : c)))
      if (moved) drop('/cards')
      refreshView()
    } catch (e) {
      set(before)
      ui.error = (e as Error).message
    }
  }

  function consider(s: Status, e: CustomEvent<DndEvent<Card>>) {
    lists = { ...lists, [s]: e.detail.items }
  }
  function finalize(s: Status, e: CustomEvent<DndEvent<Card>>) {
    lists = { ...lists, [s]: e.detail.items }
    const moved = e.detail.items.find((c) => c.id === e.detail.info.id)
    if (!moved) return
    const i = e.detail.items.indexOf(moved)
    const before = e.detail.items[i - 1]?.position
    const after = e.detail.items[i + 1]?.position
    const position = before != null && after != null ? (before + after) / 2 : before != null ? before + 1 : after != null ? after - 1 : 1
    const was = cards?.find((c) => c.id === moved.id)
    if (was && was.status === s && Math.abs(was.position - position) < 1e-9) return
    patch(moved.id, { status: s, position }, { status: s, position })
  }

  async function add(s: Status) {
    const title = draft.trim()
    adding = null
    draft = ''
    if (!title) return
    const temp: Card = {
      id: `tmp-${Date.now()}`,
      ref: '…',
      title,
      body: '',
      status: s,
      assignee: null,
      labels: [],
      position: Math.max(0, ...(cards ?? []).map((c) => c.position)) + 1,
      updatedAt: new Date().toISOString(),
      week: week === 'backlog' ? null : week,
    }
    const before = cards ?? []
    set([...before, temp])
    try {
      const c = await v2.post<Card>('/cards', { title, status: s, week })
      if (cards) set(cards.map((x) => (x.id === temp.id ? c : x)))
      refreshView()
    } catch (e) {
      set(before)
      ui.error = (e as Error).message
    }
  }

  function closed(result: { card: Card; patch: Record<string, unknown> } | { removed: string } | null) {
    open = null
    if (!result) return
    if ('removed' in result) {
      const before = cards ?? []
      set(before.filter((c) => c.id !== result.removed))
      v2.del(`/cards/${result.removed}`)
        .then(refreshView)
        .catch((e) => {
          set(before)
          ui.error = (e as Error).message
        })
      return
    }
    if (Object.keys(result.patch).length) patch(result.card.id, result.patch, result.card)
  }

  let carrying = $state(false)

  async function complete(to: 'next' | 'current' | 'backlog') {
    const before = cards ?? []
    set(before.filter((c) => c.status === 'done'))
    completing = false
    carrying = false
    menu = false
    try {
      const r = await v2.post<{ moved: number }>('/weeks/complete', { start: week, to })
      drop('/cards')
      put(cardsPath(week), cards ?? [])
      const where = to === 'backlog' ? 'the backlog' : to === 'current' ? cycleName(view?.current ?? week) : cycleName(shift(week, 1))
      ui.error = r.moved ? `${r.moved} unfinished card${r.moved === 1 ? '' : 's'} moved to ${where}` : ''
      refreshView()
    } catch (e) {
      set(before)
      ui.error = (e as Error).message
    }
  }

  function markdown(c: Card) {
    return [`# ${c.ref} ${c.title}`, `Status: ${STATUSES.find((x) => x.id === c.status)?.label}`, c.assignee ? `Assignee: ${c.assignee.name}` : '', c.body ? `\n${c.body}` : '']
      .filter(Boolean)
      .join('\n')
  }

  const groups = $derived.by(() => {
    const cs = view?.cycles ?? []
    return [
      { name: 'Upcoming', items: cs.filter((c) => !c.past && !c.current).reverse() },
      { name: 'Current', items: cs.filter((c) => c.current) },
      { name: 'Earlier', items: cs.filter((c) => c.past).reverse() },
    ].filter((g) => g.items.length)
  })
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && ((menu = false), (completing = false), (carrying = false))} />

<div class="page">
  <Header crumbs={[tabName]}>
    <div class="cyc">
      <div class="pill">
        <button class="arrow" title="Previous" disabled={week === 'backlog' || !week} onclick={() => show(shift(week, -1), -1)}><ChevronLeft size={14} /></button>
        <button class="now" onclick={() => ((menu = !menu), (completing = false))}>
          {#if week === 'backlog'}
            <Inbox size={13} /><b>Backlog</b>
          {:else if week}
            {#if view && !cycle?.current}<i class="dot" title="Not the current cycle"></i>{/if}
            <b>{cycleName(week)}</b><span>{weekRange(week, endOf(week))}</span>
          {:else}
            <Skeleton w={110} h={10} />
          {/if}
          <ChevronDown size={12} />
        </button>
        <button class="arrow" title="Next" disabled={week === 'backlog' || !week} onclick={() => show(shift(week, 1), 1)}><ChevronRight size={14} /></button>
      </div>

      {#if menu}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="catch" onclick={() => (menu = false)}></div>
        <div class="menu">
          {#if completing}
            <div class="complete">
              <b>Complete {cycleName(week)}</b>
              <span>{openHere} unfinished card{openHere === 1 ? '' : 's'}. Done cards stay here as history.</span>
              <button class="opt" onclick={() => complete('next')}>Move to {cycleName(shift(week, 1))}</button>
              <button class="opt" onclick={() => complete('backlog')}>Move to the backlog</button>
              <button class="link" onclick={() => (completing = false)}>Cancel</button>
            </div>
          {:else}
            {#if view && week !== view.current}
              <button class="row today" onclick={() => show(view!.current, view!.current > week ? 1 : -1)}>Go to the current {len === 1 ? 'week' : 'cycle'}</button>
            {/if}
            {#each groups as g (g.name)}
              <span class="gl">{g.name}</span>
              {#each g.items as c (c.start)}
                <button class="row" class:on={c.start === week} onclick={() => show(c.start, c.start > week ? 1 : -1)}>
                  <b>{c.label}</b>
                  <span class="grow">{weekRange(c.start, c.end)}</span>
                  {#if c.total}
                    <span class="bar"><i style:width="{(c.done / c.total) * 100}%"></i></span>
                    <span class="n">{c.done}/{c.total}</span>
                  {/if}
                </button>
              {/each}
            {/each}
            <div class="sep"></div>
            <button class="row" class:on={week === 'backlog'} onclick={() => show('backlog')}><Inbox size={13} /><span class="grow">Backlog</span><span class="n">{view?.backlog ?? 0}</span></button>
            <div class="sep"></div>
            {#if week !== 'backlog' && openHere}
              <button class="row" onclick={() => (completing = true)}><CircleCheck size={13} /><span class="grow">Complete {cycleName(week)}…</span></button>
            {/if}
            <button
              class="row"
              onclick={() => {
                menu = false
                openSettings('cycles')
              }}><Settings2 size={13} /><span class="grow">Cycle settings</span></button
            >
          {/if}
        </div>
      {/if}
    </div>
    {#if cards?.length}
      <CopyNode text={() => manyForClaude('card', cycleName(week), cards!.map(markdown))} label="Copy this cycle for your AI" size={13} />
    {/if}
    {#if canEditHere() && week !== 'backlog' && openHere && cycle && !(!cycle.current && !cycle.past)}
      <div class="carry">
        <button class="btn" class:open={carrying} title="Move what is not finished out of this cycle" onclick={() => ((carrying = !carrying), (menu = false))}>
          <ArrowRight size={12} /><span>Carry over</span><b>{openHere}</b>
        </button>
        {#if carrying}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="catch" onclick={() => (carrying = false)}></div>
          <div class="pop">
            <b>Carry over {openHere} unfinished card{openHere === 1 ? '' : 's'}</b>
            <span>Done cards stay in {cycleName(week)} as history.</span>
            {#if !cycle.current}
              <button class="opt" onclick={() => complete('current')}>Move to {cycleName(view?.current ?? week)} <i>the one running now</i></button>
            {/if}
            {#if cycle.current || shift(week, 1) !== view?.current}
              <button class="opt" onclick={() => complete('next')}>Move to {cycleName(shift(week, 1))}{#if !cycle.current}<i>the one after</i>{/if}</button>
            {/if}
            <button class="opt" onclick={() => complete('backlog')}>Send to the backlog</button>
            <button
              class="link"
              onclick={() => {
                carrying = false
                openSettings('cycles')
              }}>Do this on its own, every cycle…</button
            >
          </div>
        {/if}
      </div>
    {/if}
    {#if canEditHere()}<button class="btn" onclick={() => ((adding = 'todo'), (draft = ''))}><Plus size={12} /><span>New card</span></button>{/if}
  </Header>

  {#if cards && !cards.length}
    <!-- An empty cycle should say what to do with it, not show four empty columns. -->
    <div class="nothing">
      <b>{week === 'backlog' ? 'The backlog is empty.' : `Nothing in ${cycleName(week)} yet.`}</b>
      {#if canEditHere()}
        <span>
          {#if week === 'backlog'}Cards sent back from a cycle wait here.
          {:else if scope.enabled && scope.id}New cards land in this project.
          {:else}Start one, or carry unfinished work over from another cycle.{/if}
        </span>
        <div class="acts">
          <button class="btn" onclick={() => ((adding = 'todo'), (draft = ''))}><Plus size={12} /><span>New card</span></button>
          {#if week !== 'backlog'}<button class="btn" onclick={() => ((menu = true), (completing = false))}>Another cycle…</button>{/if}
        </div>
      {/if}
    </div>
  {/if}
  {#key week}
    <div class="cols" class:quiet={cards && !cards.length} in:fly={{ x: dir * 18, duration: dir ? 180 : 0 }}>
      {#each STATUSES as st, i (st.id)}
        <section class="col">
          <header>
            <span class="dot {st.id}"></span>
            <span class="name">{label(i)}</span>
            <span class="count">{cards ? lists[st.id].length : ''}</span>
            <span class="grow"></span>
            {#if lists[st.id]?.length}
              <CopyNode
                text={() => manyForClaude('card', `${label(i)} in ${cycleName(week)}`, lists[st.id].map(markdown), `status:"${st.id}"`)}
                label="Copy this column for your AI"
              />
            {/if}
            <button class="icon" title="Add a card" onclick={() => ((adding = st.id), (draft = ''))}><Plus size={13} /></button>
          </header>
          {#if adding === st.id}
            <input
              class="new"
              placeholder="Card title, then Enter"
              bind:value={draft}
              use:takeFocus
              onkeydown={(e) => {
                if (e.key === 'Enter') add(st.id)
                if (e.key === 'Escape') adding = null
              }}
              onblur={() => add(st.id)}
            />
          {/if}
          {#if cards === null}
            <div class="list">
              {#each Array(i === 3 ? 2 : 3 - (i % 2)) as _}
                <div class="card sk"><Skeleton w={48} h={9} /><Skeleton w="85%" h={11} /><Skeleton w="55%" h={11} /></div>
              {/each}
            </div>
          {:else}
            <div
              class="list"
              use:dndzone={{ items: lists[st.id], type: 'card', flipDurationMs: 120, dropTargetStyle: {} }}
              onconsider={(e) => consider(st.id, e)}
              onfinalize={(e) => finalize(st.id, e)}
            >
              {#each lists[st.id] as c (c.id)}
                <div class="card" class:done={c.status === 'done'} class:pending={c.id.startsWith('tmp-')} role="button" tabindex="0" onclick={() => (open = c)} onkeydown={(e) => e.key === 'Enter' && (open = c)}>
                  <div class="top">
                    <span class="ref">{c.ref}</span>
                    <ProjectChip kind="card" id={c.id} project={c.project ?? null} onmoved={(p) => (lists = { ...lists, [st.id]: lists[st.id].map((x) => (x.id === c.id ? { ...x, project: p } : x)) })} />
                    <CopyNode text={() => markdown(c)} as={{ kind: 'card', id: c.id, title: `${c.ref} ${c.title}` }} />
                  </div>
                  <span class="title">{c.title}</span>
                  {#if c.labels.length || c.assignee || c.body}
                    <div class="meta">
                      {#each c.labels as l}<span class="tag">{l}</span>{/each}
                      <span class="grow"></span>
                      {#if c.body}<span class="links"><Link size={11} /></span>{/if}
                      {#if c.assignee}<Face person={c.assignee} size={20} dim={c.status === 'done'} />{/if}
                    </div>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        </section>
      {/each}
    </div>
  {/key}
</div>

{#if open}
  <CardDetail card={open} {view} onclose={closed} />
{/if}

<style>
  .page {
    height: 100%;
    display: flex;
    flex-direction: column;
    min-width: 0;
    position: relative;
  }
  .cols {
    flex: 1;
    display: flex;
    gap: 12px;
    padding: 16px 20px;
    min-height: 0;
    overflow: auto;
  }
  .col {
    flex: 1;
    min-width: 220px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 28px;
    padding: 0 4px;
  }
  .name {
    font-size: 13px;
    font-weight: 500;
  }
  .count {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
  }
  .grow {
    flex: 1;
  }
  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    border: 1.5px solid var(--muted);
    box-sizing: border-box;
  }
  .dot.todo {
    border-style: dashed;
  }
  .dot.progress {
    border-color: var(--ink-2);
    background: conic-gradient(var(--ink-2) 0 50%, transparent 50% 100%);
  }
  .dot.review {
    border-color: var(--ink);
    background: conic-gradient(var(--ink) 0 75%, transparent 75% 100%);
  }
  .dot.done {
    border: 0;
    background: var(--ink-2);
  }
  .icon {
    background: none;
    border: 0;
    color: var(--muted);
    cursor: pointer;
    display: flex;
    padding: 2px;
    border-radius: 4px;
  }
  .icon:hover {
    color: var(--ink);
    background: var(--accent-soft);
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 60px;
    flex: 1;
  }
  .card {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px;
    border-radius: var(--r-lg);
    background: var(--raised);
    border: 1px solid var(--line-strong);
    cursor: pointer;
    outline: none;
  }
  .card.sk {
    cursor: default;
    gap: 9px;
  }
  .card:hover,
  .card:focus-visible {
    border-color: var(--line-strong);
  }
  .card.done {
    background: none;
    border-color: var(--line);
  }
  .card.done .title {
    color: var(--ink-2);
    font-weight: 400;
  }
  .card.pending {
    opacity: 0.6;
  }
  .top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 20px;
  }
  .ref {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
  }
  .title {
    font-size: 13px;
    font-weight: 500;
    line-height: 18px;
  }
  .meta {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .tag {
    font-size: 11px;
    color: var(--ink-2);
    padding: 1px 6px;
    border-radius: 4px;
    border: 1px solid var(--line-strong);
  }
  .links {
    color: var(--muted);
    display: flex;
  }
  .new {
    height: 34px;
    padding: 0 10px;
    border-radius: var(--r-md);
    border: 1px solid var(--line-strong);
    background: var(--bg);
    color: var(--ink);
    font: inherit;
    font-size: 13px;
  }
  .btn {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 10px;
    border-radius: var(--r-md);
    border: 1px solid var(--line-strong);
    background: none;
    color: var(--ink-2);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .btn:hover {
    color: var(--ink);
    background: var(--accent-soft);
  }

  /* One control: previous, the cycle (opens the menu), next. */
  .cyc {
    position: relative;
  }
  .pill {
    display: flex;
    align-items: center;
    height: 28px;
    border-radius: var(--r-md);
    border: 1px solid var(--line-strong);
    background: var(--panel);
    overflow: hidden;
  }
  .arrow {
    width: 26px;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 0;
    background: none;
    color: var(--muted);
    cursor: pointer;
  }
  .arrow:hover:not(:disabled) {
    color: var(--ink);
    background: var(--accent-soft);
  }
  .arrow:disabled {
    opacity: 0.3;
    cursor: default;
  }
  .now {
    display: flex;
    align-items: center;
    gap: 7px;
    height: 100%;
    padding: 0 10px;
    border: 0;
    border-left: 1px solid var(--line);
    border-right: 1px solid var(--line);
    background: none;
    color: var(--ink);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    font-variant-numeric: tabular-nums;
  }
  .now:hover {
    background: var(--accent-soft);
  }
  .now span {
    color: var(--muted);
  }
  .now .dot {
    width: 6px;
    height: 6px;
    border: 0;
    background: var(--muted);
  }
  .catch {
    position: fixed;
    inset: 0;
    z-index: 29;
  }
  .menu {
    position: absolute;
    top: 34px;
    right: 0;
    width: 300px;
    max-height: 440px;
    overflow: auto;
    z-index: 30;
    padding: 6px;
    border-radius: 10px;
    background: var(--raised);
    border: 1px solid var(--line-strong);
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.55);
    display: flex;
    flex-direction: column;
  }
  .gl {
    padding: 8px 10px 4px;
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
    font-weight: 500;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 32px;
    flex-shrink: 0;
    padding: 0 10px;
    border: 0;
    border-radius: 6px;
    background: none;
    color: var(--ink-2);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    text-align: left;
  }
  .row b {
    color: var(--ink);
    font-weight: 500;
  }
  .row:hover,
  .row.on {
    background: var(--raised);
    color: var(--ink);
  }
  .row.today {
    color: var(--ink);
  }
  .n {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
    min-width: 28px;
    text-align: right;
  }
  .bar {
    width: 40px;
    height: 3px;
    border-radius: 2px;
    background: var(--line-strong);
    overflow: hidden;
  }
  .bar i {
    display: block;
    height: 100%;
    background: var(--ink-2);
  }
  .sep {
    height: 1px;
    background: var(--line-strong);
    margin: 4px 0;
  }
  .complete {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
  }
  .complete b {
    font-size: 13px;
  }
  .complete span {
    font-size: 12px;
    color: var(--muted);
    line-height: 1.5;
    margin-bottom: 4px;
  }
  .opt {
    height: 32px;
    border-radius: 6px;
    border: 1px solid var(--line-strong);
    background: var(--panel);
    color: var(--ink);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .opt:hover {
    background: var(--raised);
  }
  .link {
    background: none;
    border: 0;
    color: var(--muted);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    padding: 4px;
  }
  /* Carrying work forward is the most common thing anyone does at the end of a
     week, so it is a button on the bar rather than an item in a menu. */
  .carry {
    position: relative;
  }
  .nothing {
    position: absolute;
    left: 0;
    right: 0;
    top: 190px;
    z-index: 2;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    pointer-events: none;
    color: var(--muted);
  }
  .nothing b {
    font-size: 15px;
    color: var(--ink-2);
    font-weight: 600;
  }
  .nothing span {
    font-size: 13px;
  }
  .nothing .acts {
    display: flex;
    gap: 8px;
    margin-top: 6px;
    pointer-events: all;
  }
  /* The columns stay, so the shape of the board is still there to drop into. */
  .cols.quiet {
    opacity: 0.5;
  }
  .carry .btn b {
    font-family: var(--mono);
    font-weight: 400;
    font-size: 11px;
    color: var(--muted);
  }
  .carry .btn.open {
    border-color: var(--muted);
  }
  .pop {
    position: absolute;
    right: 0;
    top: 34px;
    width: 268px;
    z-index: 30;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 12px;
    border-radius: 10px;
    background: var(--raised);
    border: 1px solid var(--line-strong);
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.55);
  }
  .pop b {
    font-size: 13px;
  }
  .pop span {
    font-size: 12px;
    color: var(--muted);
    line-height: 1.5;
    margin-bottom: 4px;
  }
  .pop .opt {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 0 10px;
    text-align: left;
  }
  .pop .opt i {
    font-style: normal;
    font-size: 11px;
    color: var(--muted);
  }
</style>
