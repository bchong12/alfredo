<script lang="ts">
  // Board: one cycle at a time (a week, unless the workspace says otherwise).
  // Everything is instant: cycles draw from cache and the neighbours are
  // prefetched; edits show before the server answers and undo if it refuses.
  import { canEditHere, scope } from './project.svelte'
  import { dndzone, SHADOW_ITEM_MARKER_PROPERTY_NAME, TRIGGERS, type DndEvent } from 'svelte-dnd-action'
  import { fly } from 'svelte/transition'
  import { flip } from 'svelte/animate'
  import { untrack } from 'svelte'
  import ListFilter from '@lucide/svelte/icons/list-filter'
  import Check from '@lucide/svelte/icons/check'
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
  import { workspace } from '../lib/workspace.svelte'
  import { manyForClaude } from './clip'

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

  const FLIP = 160
  /** A card is in the air. Nothing redraws the columns under it until it lands. */
  let dragging = $state(false)
  /** The columns changed while a card was in the air; draw them when it lands. */
  let stale = false
  /** Cards dropped on another cycle, for the instant between the drop and the save. */
  let parked = $state<Record<string, Card[]>>({})
  /** A card that has been typed but not yet answered for: its real self, when it arrives. */
  const arriving = new Map<string, Promise<Card | null>>()

  // --- whose cards ------------------------------------------------------------------
  // Tick people to see only their cards. Kept per workspace, on this device.
  const NOBODY = 'none'
  const whoKey = () => `alfredo.v2.board.people.${workspace.activeId}`
  let who = $state<string[]>(
    (() => {
      try {
        const v = JSON.parse(localStorage.getItem(whoKey()) ?? '[]')
        return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
      } catch {
        return []
      }
    })(),
  )
  let filtering = $state(false)
  /** Only people who are still here count; someone who left does not hide the board. */
  const picked = $derived(who.filter((id) => id === NOBODY || !ui.members.length || ui.members.some((m) => m.id === id)))
  const pickedPeople = $derived(ui.members.filter((m) => picked.includes(m.id)))
  const shown = (c: Card) => !picked.length || picked.includes(c.assignee?.id ?? NOBODY)
  function setWho(next: string[]) {
    who = next
    try {
      localStorage.setItem(whoKey(), JSON.stringify(next))
    } catch {}
  }
  const toggleWho = (id: string) => setWho(who.includes(id) ? who.filter((x) => x !== id) : [...who, id])
  const hidden = $derived(cards ? cards.filter((c) => !shown(c)).length : 0)
  /** Who a card made while filtering belongs to, so it does not vanish as it is made. */
  const newOwner = $derived.by(() => {
    if (!picked.length || picked.includes(NOBODY)) return null
    return (ui.me && picked.includes(ui.me.id) ? ui.me : pickedPeople[0]) ?? null
  })
  $effect(() => {
    void picked
    untrack(() => cards && spread(cards))
  })

  // The app refreshes itself now and then by remaking the tab. Not while a
  // card is being typed or carried: that is how a half-typed card vanished.
  $effect(() => {
    ui.held = dragging || adding !== null
    return () => (ui.held = false)
  })

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
    if (dragging) {
      stale = true
      return
    }
    const next: Record<Status, Card[]> = { todo: [], progress: [], review: [], done: [] }
    for (const c of [...list].sort((a, b) => a.position - b.position)) if (shown(c)) next[c.status].push(c)
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
    dragging = true
    lists = { ...lists, [s]: e.detail.items }
  }
  /** The drag is over: draw what arrived while the card was in the air. */
  function landed() {
    dragging = false
    if (stale && cards) {
      stale = false
      spread(cards)
    }
  }
  /** Save a move, to the card's real self if it was still being made. */
  function move(id: string, p: Record<string, unknown>, local: Partial<Card>) {
    const coming = arriving.get(id)
    if (coming) coming.then((real) => real && patch(real.id, p, local))
    else patch(id, p, local)
  }
  function finalize(s: Status, e: CustomEvent<DndEvent<Card>>) {
    lists = { ...lists, [s]: e.detail.items }
    // It left for another column or another cycle; whoever caught it saves it.
    if (e.detail.info.trigger === TRIGGERS.DROPPED_INTO_ANOTHER) return
    const moved = e.detail.items.find((c) => c.id === e.detail.info.id)
    if (!moved) return landed()
    const i = e.detail.items.indexOf(moved)
    const above = e.detail.items[i - 1]
    const below = e.detail.items[i + 1]
    const before = above?.position
    const after = below?.position
    // Between its neighbours; first in a column is just above the first; last
    // is where a card made this second would go, so later ones still follow it.
    const position =
      before != null && after != null ? (before + after) / 2 : before != null ? Math.max(before + 0.001, Date.now() / 1e6) : after != null ? after - 1 : Date.now() / 1e6
    const was = cards?.find((c) => c.id === moved.id)
    // Dropped where it was picked up: the same column, between the same two cards.
    const home = (cards ?? []).filter((c) => c.status === s && shown(c)).sort((a, b) => a.position - b.position)
    const h = home.findIndex((c) => c.id === moved.id)
    const unchanged = !!was && was.status === s && h >= 0 && home[h - 1]?.id === above?.id && home[h + 1]?.id === below?.id
    // Put the move in the cards themselves before anything redraws, so the
    // card does not flick back to where it was while the save is on its way.
    if (!unchanged && cards) cards = cards.map((c) => (c.id === moved.id ? { ...c, status: s, position } : c))
    stale = true
    landed()
    if (!unchanged) move(moved.id, { status: s, position }, { status: s, position })
  }

  // Somewhere to drop a card that belongs in another cycle. Only there mid-drag.
  const elsewhere = $derived.by(() => {
    if (!week || !view) return [] as { id: string; label: string }[]
    if (week === 'backlog') return [{ id: view.current, label: cycleName(view.current) }]
    return [
      { id: shift(week, -1), label: cycleName(shift(week, -1)) === cycleName(week) ? 'Previous' : cycleName(shift(week, -1)) },
      { id: shift(week, 1), label: cycleName(shift(week, 1)) === cycleName(week) ? 'Next' : cycleName(shift(week, 1)) },
      { id: 'backlog', label: 'Backlog' },
    ]
  })
  let note = $state('')
  function dropElsewhere(to: string, label: string, e: CustomEvent<DndEvent<Card>>) {
    const moved = e.detail.items.find((c) => c.id === e.detail.info.id) ?? e.detail.items[0]
    parked = { ...parked, [to]: [] }
    stale = true
    landed()
    if (!moved) return
    move(moved.id, { week: to }, { week: to === 'backlog' ? null : to })
    note = `${moved.ref === '…' ? 'Card' : moved.ref} moved to ${label}`
    setTimeout(() => (note = ''), 2600)
  }

  /** `more`: Enter was pressed, so the box stays for the next card. */
  async function add(s: Status, more = false) {
    const title = draft.trim()
    if (!more || !title) adding = null
    draft = ''
    if (!title) return
    const owner = newOwner
    // On top of the column, under the box it was typed in: a card that lands
    // at the foot of a long column looks like a card that was lost.
    // Several typed in a row stay in the order they were typed: each goes
    // under the one before it, above what the column already had.
    let top: number
    if (run && run.status === s) top = run.last = (run.last + run.floor) / 2
    else {
      const inColumn = (cards ?? []).filter((c) => c.status === s).map((c) => c.position)
      top = inColumn.length ? Math.min(...inColumn) - 1 : Date.now() / 1e6
      run = { status: s, last: top, floor: inColumn.length ? Math.min(...inColumn) : top + 1 }
    }
    const temp: Card = {
      id: `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      ref: '…',
      title,
      body: '',
      status: s,
      assignee: owner,
      labels: [],
      position: top,
      updatedAt: new Date().toISOString(),
      week: week === 'backlog' ? null : week,
    }
    set([...(cards ?? []), temp])
    const made = v2
      .post<Card>('/cards', { title, status: s, week, position: top, ...(owner ? { assigneeId: owner.id } : {}) })
      .then((c) => {
        // Where it was dragged to while it was being made is where it stays.
        const now = cards?.find((x) => x.id === temp.id)
        const real = now ? { ...c, status: now.status, position: now.position } : c
        if (cards) set(cards.map((x) => (x.id === temp.id ? real : x)))
        refreshView()
        return real
      })
      .catch((e) => {
        if (cards) set(cards.filter((x) => x.id !== temp.id))
        ui.error = `Could not save “${title.slice(0, 40)}”. ${(e as Error).message}`
        return null
      })
      .finally(() => arriving.delete(temp.id))
    arriving.set(temp.id, made)
  }
  /** Open the box in a column and bring it into view. */
  function compose(s: Status) {
    adding = s
    draft = ''
    run = null
  }
  /** The cards typed since the box opened: where the last one went, and what they sit above. */
  let run: { status: Status; last: number; floor: number } | null = null
  /** The cursor is in the box the moment it exists, so the first key typed is not lost. */
  function focusNow(el: HTMLInputElement) {
    el.focus()
    requestAnimationFrame(() => document.activeElement !== el && el.focus())
  }
  const isShadow = (c: Card) => !!(c as any)[SHADOW_ITEM_MARKER_PROPERTY_NAME]

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

<svelte:window onkeydown={(e) => e.key === 'Escape' && ((menu = false), (completing = false), (carrying = false), (filtering = false))} />

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
    {#if ui.members.length}
      <div class="carry">
        <button class="btn" class:open={filtering} class:set={picked.length > 0} title="Show only some people's cards" onclick={() => ((filtering = !filtering), (menu = false), (carrying = false))}>
          {#if picked.length}
            <span class="faces">
              {#each pickedPeople.slice(0, 3) as m (m.id)}<Face person={m} size={16} />{/each}
              {#if picked.includes(NOBODY)}<Face person={null} size={16} />{/if}
            </span>
            <span>{picked.length === 1 ? (pickedPeople[0]?.name.split(' ')[0] ?? 'Unassigned') : `${picked.length} people`}</span>
          {:else}
            <ListFilter size={12} /><span>Filter</span>
          {/if}
        </button>
        {#if filtering}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="catch" onclick={() => (filtering = false)}></div>
          <div class="pop people">
            <span class="gl">Assigned to</span>
            {#each ui.members as m (m.id)}
              <button class="person" role="checkbox" aria-checked={who.includes(m.id)} onclick={() => toggleWho(m.id)}>
                <span class="box" class:on={who.includes(m.id)}>{#if who.includes(m.id)}<Check size={11} strokeWidth={3} />{/if}</span>
                <Face person={m} size={18} />
                <span class="grow">{m.name}{#if m.id === ui.me?.id}<i>you</i>{/if}</span>
                <span class="n">{(cards ?? []).filter((c) => c.assignee?.id === m.id).length || ''}</span>
              </button>
            {/each}
            <button class="person" role="checkbox" aria-checked={who.includes(NOBODY)} onclick={() => toggleWho(NOBODY)}>
              <span class="box" class:on={who.includes(NOBODY)}>{#if who.includes(NOBODY)}<Check size={11} strokeWidth={3} />{/if}</span>
              <Face person={null} size={18} />
              <span class="grow">Nobody yet</span>
              <span class="n">{(cards ?? []).filter((c) => !c.assignee).length || ''}</span>
            </button>
            <div class="sep"></div>
            <div class="foot">
              {#if ui.me}<button class="link" onclick={() => setWho([ui.me!.id])}>Only mine</button>{/if}
              <span class="grow"></span>
              <button class="link" disabled={!who.length} onclick={() => setWho([])}>Show everyone</button>
            </div>
          </div>
        {/if}
      </div>
    {/if}
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
    {#if canEditHere()}<button class="btn" onclick={() => compose('todo')}><Plus size={12} /><span>New card</span></button>{/if}
  </Header>

  {#if cards && cards.length && hidden === cards.length && !adding}
    <!-- There are cards; the filter is hiding all of them. Say so. -->
    <div class="nothing">
      <b>No cards for {pickedPeople.length === 1 && !picked.includes(NOBODY) ? pickedPeople[0].name.split(' ')[0] : 'the people ticked'} here.</b>
      <span>{cards.length} card{cards.length === 1 ? '' : 's'} in {week === 'backlog' ? 'the backlog' : cycleName(week)} belong to someone else.</span>
      <div class="acts"><button class="btn" onclick={() => setWho([])}>Show everyone</button></div>
    </div>
  {/if}
  {#if cards && !cards.length && !adding}
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
          <button class="btn" onclick={() => compose('todo')}><Plus size={12} /><span>New card</span></button>
          {#if week !== 'backlog'}<button class="btn" onclick={() => ((menu = true), (completing = false))}>Another cycle…</button>{/if}
        </div>
      {/if}
    </div>
  {/if}
  {#key week}
    {#if dragging && elsewhere.length && canEditHere()}
      <!-- Only here while a card is in the air: drop it on another cycle. It
           floats, so nothing on the board moves when it appears. -->
      <div class="elsewhere" in:fly={{ y: 8, duration: 140 }}>
        <span class="hint">Move to</span>
        {#each elsewhere as t (t.id)}
          <div
            class="target"
            class:over={(parked[t.id] ?? []).length > 0}
            use:dndzone={{ items: parked[t.id] ?? [], type: 'card', flipDurationMs: 0, dropTargetStyle: {}, morphDisabled: true }}
            onconsider={(e) => (parked = { ...parked, [t.id]: e.detail.items })}
            onfinalize={(e) => dropElsewhere(t.id, t.label, e)}
          >
            {#if t.id === 'backlog'}<Inbox size={12} />{/if}<b>{t.label}</b>
            {#each parked[t.id] ?? [] as c (c.id)}<span class="held">{c.title}</span>{/each}
          </div>
        {/each}
      </div>
    {/if}
    <div class="cols" class:lifting={dragging && elsewhere.length > 0 && canEditHere()} class:quiet={cards && !cards.length && !adding} in:fly={{ x: dir * 18, duration: dir ? 180 : 0 }}>
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
            {#if canEditHere()}<button class="icon" title="Add a card" onclick={() => compose(st.id)}><Plus size={13} /></button>{/if}
          </header>
          {#if cards === null}
            <div class="list">
              {#each Array(i === 3 ? 2 : 3 - (i % 2)) as _}
                <div class="card sk"><Skeleton w={48} h={9} /><Skeleton w="85%" h={11} /><Skeleton w="55%" h={11} /></div>
              {/each}
            </div>
          {:else}
            <div class="scroll">
            {#if adding === st.id}
              <!-- On top, where the card it makes will land. -->
              <div class="composer">
                <input
                  class="new"
                  placeholder="Card title"
                  bind:value={draft}
                  use:focusNow
                  onkeydown={(e) => {
                    if (e.key === 'Enter' && !e.isComposing) (e.preventDefault(), add(st.id, true))
                    if (e.key === 'Escape') (e.stopPropagation(), (draft = ''), (adding = null))
                  }}
                  onblur={() => adding === st.id && add(st.id)}
                />
                <span class="how">Enter adds it{#if newOwner}, for {newOwner.name.split(' ')[0]}{/if}. Esc closes.</span>
              </div>
            {/if}
            <div
              class="list"
              class:over={dragging && lists[st.id].some(isShadow)}
              use:dndzone={{
                items: lists[st.id],
                type: 'card',
                flipDurationMs: FLIP,
                dropTargetStyle: {},
                morphDisabled: true,
                // The card sits under the cursor, so what the cursor points at is what it is over.
                centreDraggedOnCursor: true,
                dragDisabled: !canEditHere(),
                transformDraggedElement: (el) => el?.classList.add('lifted'),
              }}
              onconsider={(e) => consider(st.id, e)}
              onfinalize={(e) => finalize(st.id, e)}
            >
              {#each lists[st.id] as c (c.id)}
                <div
                  class="card"
                  class:done={c.status === 'done'}
                  class:pending={c.id.startsWith('tmp-')}
                  class:ghost={(c as any)[SHADOW_ITEM_MARKER_PROPERTY_NAME]}
                  animate:flip={{ duration: FLIP }}
                  role="button"
                  tabindex="0"
                  onclick={() => !c.id.startsWith('tmp-') && (open = c)}
                  onkeydown={(e) => e.key === 'Enter' && !c.id.startsWith('tmp-') && (open = c)}
                >
                  <div class="top">
                    <span class="ref">{c.ref}</span>
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
            </div>
          {/if}
        </section>
      {/each}
    </div>
  {/key}
</div>

{#if note}<div class="note" in:fly={{ y: 6, duration: 140 }}>{note}</div>{/if}

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
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  /* While a card is in the air the columns end a little higher, leaving the
     foot of the page to the other-cycle targets. Columns hang from the top, so
     no card moves. */
  .cols.lifting {
    padding-bottom: 92px;
  }
  /* Each column scrolls on its own, so its name stays put over a long list. */
  .scroll {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    overflow-y: auto;
    overflow-x: hidden;
    scrollbar-width: none;
    margin: 0 -4px;
    padding: 0 4px 12px;
  }
  .scroll::-webkit-scrollbar {
    display: none;
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
    border-radius: var(--r-lg);
    outline: 1px dashed transparent;
    outline-offset: 3px;
    transition: outline-color 120ms, background 120ms;
  }
  /* The column a card is over says so. */
  .list.over {
    outline-color: var(--line-strong);
    background: color-mix(in srgb, var(--raised) 45%, transparent);
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
  .card {
    cursor: grab;
    user-select: none;
  }
  .card:active {
    cursor: grabbing;
  }
  /* Where the card will land: its shape, without its words. */
  .card.ghost {
    visibility: visible !important;
    background: none;
    border: 1px dashed var(--line-strong);
    opacity: 1;
  }
  .card.ghost > :global(*) {
    visibility: hidden;
  }
  /* The card in the hand. */
  :global(.card.lifted) {
    cursor: grabbing !important;
    border-color: var(--muted) !important;
    box-shadow: 0 18px 44px rgba(0, 0, 0, 0.5), 0 2px 6px rgba(0, 0, 0, 0.35);
    opacity: 1 !important;
  }
  .composer {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .how {
    padding: 0 2px;
    font-size: 11px;
    color: var(--muted);
  }
  .elsewhere {
    position: absolute;
    left: 50%;
    bottom: 18px;
    transform: translateX(-50%);
    z-index: 6;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 8px 8px 14px;
    border-radius: 12px;
    background: var(--raised);
    border: 1px solid var(--line-strong);
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.45);
  }
  .elsewhere .hint {
    font-size: 12px;
    color: var(--muted);
  }
  .target {
    width: 140px;
    height: 46px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    overflow: hidden;
    border-radius: var(--r-md);
    border: 1px dashed var(--line-strong);
    color: var(--ink-2);
    font-size: 12px;
    transition: background 120ms, border-color 120ms, color 120ms;
  }
  .target b {
    font-weight: 500;
  }
  .target.over {
    border-color: var(--ink-2);
    background: var(--raised);
    color: var(--ink);
  }
  /* What is dropped here is on its way out; it does not need drawing. */
  .target :global(.card),
  .held {
    display: none !important;
  }
  .note {
    position: absolute;
    left: 50%;
    bottom: 20px;
    transform: translateX(-50%);
    z-index: 5;
    padding: 7px 12px;
    border-radius: var(--r-md);
    background: var(--raised);
    border: 1px solid var(--line-strong);
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
    font-size: 12px;
    color: var(--ink);
    pointer-events: none;
  }
  .btn.set {
    color: var(--ink);
    border-color: var(--muted);
  }
  .faces {
    display: flex;
  }
  .faces :global(.face + .face) {
    margin-left: -5px;
  }
  .pop.people {
    width: 252px;
    gap: 1px;
    padding: 6px;
    max-height: 420px;
    overflow: auto;
  }
  .pop.people span {
    margin-bottom: 0;
    line-height: 1.2;
  }
  .person {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 32px;
    flex-shrink: 0;
    padding: 0 8px;
    border: 0;
    border-radius: 6px;
    background: none;
    color: var(--ink);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    text-align: left;
  }
  .person:hover {
    background: var(--accent-soft);
  }
  .person .grow {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--ink);
    margin: 0;
    font-size: 12px;
  }
  .person i {
    font-style: normal;
    color: var(--muted);
    margin-left: 6px;
  }
  .person .n {
    margin: 0;
  }
  .box {
    width: 14px;
    height: 14px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
    border: 1px solid var(--muted);
    color: var(--bg);
  }
  .box.on {
    background: var(--ink);
    border-color: var(--ink);
  }
  .foot {
    display: flex;
    align-items: center;
    padding: 0 4px;
  }
  .foot .link:disabled {
    opacity: 0.4;
    cursor: default;
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
