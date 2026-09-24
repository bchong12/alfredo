<script lang="ts">
  // Requests, per product: what people asked for, most wanted first, each
  // with its votes, its status, and the card it became. The team adds and
  // answers here; the people who use the product add through the portal and
  // land in the same board.
  import Plus from '@lucide/svelte/icons/plus'
  import X from '@lucide/svelte/icons/x'
  import ChevronUp from '@lucide/svelte/icons/chevron-up'
  import Bug from '@lucide/svelte/icons/bug'
  import Lightbulb from '@lucide/svelte/icons/lightbulb'
  import Columns3 from '@lucide/svelte/icons/columns-3'
  import Settings2 from '@lucide/svelte/icons/settings-2'
  import Trash2 from '@lucide/svelte/icons/trash-2'
  import Header from '../../Header.svelte'
  import Select from '../../Select.svelte'
  import Face from '../../Face.svelte'
  import { v2, type Card } from '../../api'
  import { ui, go, visibleTabs } from '../../state.svelte'
  import { canEditHere, scope } from '../../project.svelte'
  import { peek, load as fetchCached, put } from '../../cache'
  import { EMPTY, DEFAULT_SETTINGS, STATUSES, KINDS, tidy, tidySettings, ranked, settled, statusLabel, newId, ago, type Board, type Request, type Settings, type Kind, type Status } from './model'

  let { tabName }: { kind: string; tabName: string; view: string } = $props()

  // --- which products, and which one is open ------------------------------------
  const SETTINGS = '/packs/requests.settings'
  let settings = $state<Settings>(tidySettings(peek(SETTINGS) ?? DEFAULT_SETTINGS))
  let product = $state<string>(settings.products[0].id)
  fetchCached<unknown>(SETTINGS)
    .then((raw) => {
      settings = tidySettings(raw)
      if (!settings.products.some((p) => p.id === product)) product = settings.products[0].id
    })
    .catch(() => {})

  // --- the board of the product in view ------------------------------------------
  const PATH = $derived(`/packs/requests.${product}`)
  let board = $state<Board>(EMPTY)
  let loading = $state(true)
  $effect(() => {
    const path = PATH
    board = tidy(peek(path) ?? EMPTY)
    loading = peek(path) === undefined
    fetchCached<unknown>(path)
      .then((raw) => {
        if (path === PATH) board = tidy(raw)
      })
      .catch(() => {})
      .finally(() => {
        if (path === PATH) loading = false
      })
  })
  const canEdit = $derived(canEditHere())
  const me = () => ui.me?.id ?? 'me'

  let saving = $state(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  function changed(next: Board) {
    board = tidy(next)
    const path = PATH
    put(path, $state.snapshot(board))
    saving = true
    clearTimeout(timer)
    timer = setTimeout(async () => {
      try {
        await v2.put(path, $state.snapshot(board))
      } catch (e) {
        ui.error = (e as Error).message
      }
      saving = false
    }, 400)
  }
  const patch = (id: string, p: Partial<Request>) => changed({ items: board.items.map((r) => (r.id === id ? { ...r, ...p, updatedAt: new Date().toISOString() } : r)) })
  const vote = (r: Request) => patch(r.id, { votes: r.votes.includes(me()) ? r.votes.filter((v) => v !== me()) : [...r.votes, me()] })
  const remove = (id: string) => {
    if (!confirm('Delete this request? Its votes go with it.')) return
    changed({ items: board.items.filter((r) => r.id !== id) })
    open = null
  }

  // --- filters ------------------------------------------------------------------
  let kindFilter = $state<'all' | Kind>('all')
  let showSettled = $state(false)
  let q = $state('')
  const shown = $derived(
    ranked(board.items).filter((r) => (kindFilter === 'all' || r.kind === kindFilter) && (showSettled || !settled(r.status)) && (!q.trim() || `${r.title} ${r.body}`.toLowerCase().includes(q.trim().toLowerCase()))),
  )
  const settledCount = $derived(board.items.filter((r) => settled(r.status)).length)

  // --- one request, open --------------------------------------------------------
  let open = $state<string | null>(null)
  const current = $derived(open ? (board.items.find((r) => r.id === open) ?? null) : null)
  const boardTab = () => visibleTabs().find((t) => t.type === 'board')?.id
  let makingCard = $state(false)
  async function makeCard(r: Request) {
    if (makingCard) return
    makingCard = true
    try {
      const card = await v2.post<Card>('/cards', { title: r.title, status: 'todo' })
      await v2.patch(`/cards/${card.id}`, { body: `${r.kind === 'bug' ? 'Bug' : 'Request'} from ${r.by.name}${r.by.via === 'portal' ? ' (portal)' : ''}, ${r.votes.length} vote${r.votes.length === 1 ? '' : 's'}.\n\n${r.body}` })
      if (scope.enabled && scope.id && scope.id !== 'none') await v2.post('/projects/assign', { kind: 'card', ids: [card.id], project: scope.id }).catch(() => {})
      patch(r.id, { card: { id: card.id, ref: card.ref }, status: r.status === 'new' || r.status === 'review' ? 'planned' : r.status })
    } catch (e) {
      ui.error = (e as Error).message
    } finally {
      makingCard = false
    }
  }

  // --- a new one, from the team -------------------------------------------------
  let adding = $state(false)
  let draft = $state<{ kind: Kind; title: string; body: string }>({ kind: 'request', title: '', body: '' })
  function add() {
    const title = draft.title.trim()
    if (!title) return
    const now = new Date().toISOString()
    const r: Request = { id: newId(), kind: draft.kind, title, body: draft.body.trim(), status: 'new', votes: [me()], by: { name: ui.me?.name ?? 'Someone', email: ui.me?.email ?? undefined, via: 'team' }, createdAt: now, updatedAt: now }
    changed({ items: [r, ...board.items] })
    draft = { kind: 'request', title: '', body: '' }
    adding = false
    open = r.id
  }

  // --- the products themselves (admins) -----------------------------------------
  let editingProducts = $state(false)
  let productDraft = $state('')
  async function saveSettings(next: Settings) {
    settings = tidySettings(next)
    put(SETTINGS, $state.snapshot(settings))
    try {
      await v2.put(SETTINGS, $state.snapshot(settings))
    } catch (e) {
      ui.error = (e as Error).message
    }
  }
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const addProduct = () => {
    const label = productDraft.trim()
    const id = slug(label)
    if (!id || settings.products.some((p) => p.id === id)) return
    saveSettings({ products: [...settings.products, { id, label }] })
    productDraft = ''
  }
  const dropProduct = (id: string) => {
    if (settings.products.length < 2 || !confirm('Remove this product from the list? Its requests stay in the database until the product is added back.')) return
    saveSettings({ products: settings.products.filter((p) => p.id !== id) })
    if (product === id) product = settings.products.find((p) => p.id !== id)!.id
  }
  const productLabel = (id: string) => settings.products.find((p) => p.id === id)?.label ?? id
</script>

<div class="page">
  <Header crumbs={[tabName, productLabel(product)]}>
    <span class="state">{saving ? 'Saving…' : ''}</span>
    {#if scope.canManage}<button class="ghost" title="Which products take requests" onclick={() => (editingProducts = true)}><Settings2 size={13} /></button>{/if}
    {#if canEdit}<button class="primary" onclick={() => (adding = true)}><Plus size={14} /><span>New request</span></button>{/if}
  </Header>

  <div class="scroll">
    <div class="wrap">
      <div class="bar">
        <div class="products" role="tablist">
          {#each settings.products as p (p.id)}
            <button role="tab" class:on={product === p.id} aria-selected={product === p.id} onclick={() => (product = p.id)}>{p.label}</button>
          {/each}
        </div>
        <span class="grow"></span>
        <div class="seg">
          <button class:on={kindFilter === 'all'} onclick={() => (kindFilter = 'all')}>All</button>
          <button class:on={kindFilter === 'request'} onclick={() => (kindFilter = 'request')}>Requests</button>
          <button class:on={kindFilter === 'bug'} onclick={() => (kindFilter = 'bug')}>Bugs</button>
        </div>
        <input class="search" placeholder="Find" bind:value={q} />
      </div>

      {#if loading && !board.items.length}
        <p class="empty">Loading…</p>
      {:else if !shown.length}
        <p class="empty">
          {#if board.items.length}Nothing open{settledCount ? ` (${settledCount} settled)` : ''}.{:else}Nothing asked of {productLabel(product)} yet. The team adds requests here; people using it add from the portal.{/if}
        </p>
      {:else}
        <ul class="list">
          {#each shown as r (r.id)}
            <li class:settled={settled(r.status)}>
              <button class="votes" class:mine={r.votes.includes(me())} title={r.votes.includes(me()) ? 'Take your vote back' : 'Vote for this'} disabled={!canEdit} onclick={() => vote(r)}>
                <ChevronUp size={14} /><span>{r.votes.length}</span>
              </button>
              <button class="main" onclick={() => (open = r.id)}>
                <span class="t">{r.title}</span>
                <span class="s">
                  <span class="kind" class:bug={r.kind === 'bug'}>{#if r.kind === 'bug'}<Bug size={11} />{:else}<Lightbulb size={11} />{/if}{r.kind === 'bug' ? 'Bug' : 'Request'}</span>
                  <span>{r.by.name}{r.by.via === 'portal' ? ' · portal' : ''} · {ago(r.createdAt)}</span>
                  {#if r.card}<span class="ref">{r.card.ref}</span>{/if}
                </span>
              </button>
              <span class="status s-{r.status}">{statusLabel(r.status)}</span>
            </li>
          {/each}
        </ul>
        {#if settledCount}
          <button class="ghost sm more" onclick={() => (showSettled = !showSettled)}>{showSettled ? 'Hide settled' : `Show ${settledCount} settled`}</button>
        {/if}
      {/if}
    </div>
  </div>
</div>

{#if current}
  {@const r = current}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="scrim" onclick={() => (open = null)}>
    <div class="sheet" onclick={(e) => e.stopPropagation()}>
      <div class="head">
        <span class="kind" class:bug={r.kind === 'bug'}>{#if r.kind === 'bug'}<Bug size={11} />{:else}<Lightbulb size={11} />{/if}{r.kind === 'bug' ? 'Bug' : 'Request'}</span>
        <span class="grow"></span>
        <button class="votes big" class:mine={r.votes.includes(me())} disabled={!canEdit} onclick={() => vote(r)}><ChevronUp size={14} /><span>{r.votes.length}</span></button>
        <button class="x" aria-label="Close" onclick={() => (open = null)}><X size={14} /></button>
      </div>
      {#if canEdit}
        <input class="title" value={r.title} onchange={(e) => patch(r.id, { title: e.currentTarget.value.trim() || r.title })} />
        <textarea class="body" rows="5" placeholder="What happened, or what would help." value={r.body} onchange={(e) => patch(r.id, { body: e.currentTarget.value })}></textarea>
      {:else}
        <h2 class="title">{r.title}</h2>
        <p class="body">{r.body}</p>
      {/if}
      <div class="row">
        <span class="lab">Status</span>
        <Select value={r.status} width="150px" disabled={!canEdit} options={STATUSES} onchange={(v) => patch(r.id, { status: v as Status })} ariaLabel="Status" />
        <span class="grow"></span>
        {#if r.card}
          <button class="ref big" onclick={() => boardTab() && go(boardTab()!)}><Columns3 size={12} />{r.card.ref}</button>
        {:else if canEdit}
          <button class="ghost sm" disabled={makingCard} onclick={() => makeCard(r)}><Columns3 size={12} />{makingCard ? 'Adding…' : 'Add to board'}</button>
        {/if}
      </div>
      <div class="row who">
        <span class="lab">From</span>
        <span>{r.by.name}{r.by.email ? ` (${r.by.email})` : ''}{r.by.via === 'portal' ? ', through the portal' : ''} · {ago(r.createdAt)}</span>
      </div>
      <div class="reply">
        <span class="lab">The team's reply</span>
        <span class="note">Shown to whoever asked, and to everyone who voted.</span>
        <textarea rows="3" placeholder="What you decided, or what you need to know." disabled={!canEdit} value={r.reply ?? ''} onchange={(e) => patch(r.id, { reply: e.currentTarget.value })}></textarea>
      </div>
      {#if canEdit}
        <div class="foot"><button class="ghost sm danger" onclick={() => remove(r.id)}><Trash2 size={12} />Delete</button></div>
      {/if}
    </div>
  </div>
{/if}

{#if adding}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="scrim" onclick={() => (adding = false)}>
    <div class="sheet" onclick={(e) => e.stopPropagation()}>
      <div class="head"><b>New {draft.kind === 'bug' ? 'bug' : 'request'} for {productLabel(product)}</b><span class="grow"></span><button class="x" aria-label="Close" onclick={() => (adding = false)}><X size={14} /></button></div>
      <div class="seg">
        {#each KINDS as k (k.value)}<button class:on={draft.kind === k.value} onclick={() => (draft.kind = k.value)}>{k.label}</button>{/each}
      </div>
      <!-- svelte-ignore a11y_autofocus -->
      <input class="title" placeholder={draft.kind === 'bug' ? 'What is broken, in a line' : 'What would help, in a line'} bind:value={draft.title} autofocus onkeydown={(e) => e.key === 'Enter' && add()} />
      <textarea class="body" rows="5" placeholder={draft.kind === 'bug' ? 'What you did, what happened, what you expected.' : 'Who needs it and why.'} bind:value={draft.body}></textarea>
      <div class="foot"><button class="primary" disabled={!draft.title.trim()} onclick={add}>Add</button></div>
    </div>
  </div>
{/if}

{#if editingProducts}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="scrim" onclick={() => (editingProducts = false)}>
    <div class="sheet" onclick={(e) => e.stopPropagation()}>
      <div class="head"><b>Products</b><span class="grow"></span><button class="x" aria-label="Close" onclick={() => (editingProducts = false)}><X size={14} /></button></div>
      <span class="note">Each product has its own board of requests. The portal files what people send under the product they were using.</span>
      <ul class="plist">
        {#each settings.products as p (p.id)}
          <li><span class="t">{p.label}</span><span class="mono">requests.{p.id}</span>{#if settings.products.length > 1}<button class="x" aria-label="Remove {p.label}" onclick={() => dropProduct(p.id)}><X size={13} /></button>{/if}</li>
        {/each}
      </ul>
      <div class="row"><input class="title" placeholder="New product, e.g. Crew app" bind:value={productDraft} onkeydown={(e) => e.key === 'Enter' && addProduct()} /><button class="ghost sm" disabled={!productDraft.trim()} onclick={addProduct}>Add</button></div>
    </div>
  </div>
{/if}

<style>
  .page {
    height: 100%;
    display: flex;
    flex-direction: column;
  }
  .scroll {
    flex: 1;
    overflow: auto;
  }
  .wrap {
    max-width: 880px;
    margin: 0 auto;
    padding: 28px 32px 60px;
  }
  .state {
    font-size: 12px;
    color: var(--muted);
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 18px;
  }
  .grow {
    flex: 1;
  }
  .products {
    display: flex;
    gap: 4px;
  }
  .products button,
  .seg button {
    height: 28px;
    padding: 0 11px;
    border-radius: 7px;
    border: 1px solid transparent;
    background: none;
    color: var(--ink-2);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }
  .products button.on {
    background: var(--raised);
    color: var(--ink);
    border-color: var(--line-strong);
  }
  .seg {
    display: inline-flex;
    gap: 2px;
    padding: 2px;
    border: 1px solid var(--line);
    border-radius: 8px;
  }
  .seg button {
    height: 24px;
    font-size: 12px;
    border-radius: 6px;
  }
  .seg button.on {
    background: var(--raised);
    color: var(--ink);
  }
  .search {
    width: 140px;
    height: 28px;
    padding: 0 10px;
    border-radius: 7px;
    border: 1px solid var(--line);
    background: var(--panel);
    color: var(--ink);
    font: inherit;
    font-size: 13px;
  }
  .empty {
    color: var(--muted);
    font-size: 13px;
    line-height: 1.6;
    max-width: 520px;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    border: 1px solid var(--line);
    border-radius: var(--r-lg);
    background: var(--panel);
    overflow: hidden;
  }
  .list li {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--line);
  }
  .list li:last-child {
    border-bottom: 0;
  }
  .list li.settled {
    opacity: 0.6;
  }
  .votes {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0;
    width: 40px;
    height: 40px;
    flex: none;
    border-radius: 8px;
    border: 1px solid var(--line-strong);
    background: none;
    color: var(--ink-2);
    font: inherit;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    cursor: pointer;
  }
  .votes.mine {
    background: var(--ink);
    color: var(--bg);
    border-color: var(--ink);
  }
  .votes:disabled {
    cursor: default;
  }
  .votes.big {
    flex-direction: row;
    gap: 4px;
    width: auto;
    height: 28px;
    padding: 0 10px;
  }
  .main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
    text-align: left;
    background: none;
    border: 0;
    padding: 0;
    font: inherit;
    color: var(--ink);
    cursor: pointer;
  }
  .t {
    font-size: 13px;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .s {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--muted);
  }
  .kind {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: var(--ink-2);
  }
  .kind.bug {
    color: var(--danger);
  }
  .ref {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--ink-2);
  }
  .ref.big {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 26px;
    padding: 0 9px;
    border-radius: 6px;
    border: 1px solid var(--line-strong);
    background: var(--raised);
    color: var(--ink);
    cursor: pointer;
  }
  .status {
    flex: none;
    font-size: 11px;
    padding: 3px 8px;
    border-radius: 999px;
    border: 1px solid var(--line-strong);
    color: var(--ink-2);
  }
  .status.s-progress,
  .status.s-planned {
    color: var(--ink);
  }
  .status.s-done {
    color: var(--running);
    border-color: var(--running);
  }
  .more {
    margin-top: 12px;
  }
  .scrim {
    position: fixed;
    inset: 0;
    background: var(--scrim);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 60;
  }
  .sheet {
    width: 620px;
    max-height: 84vh;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 20px 24px 24px;
    box-sizing: border-box;
    background: var(--panel);
    border: 1px solid var(--line-strong);
    border-radius: 12px;
    box-shadow: var(--shadow-md);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 13px;
  }
  .x {
    display: flex;
    background: none;
    border: 0;
    color: var(--muted);
    cursor: pointer;
    padding: 4px;
  }
  .title {
    font: inherit;
    font-size: 18px;
    font-weight: 600;
    color: var(--ink);
    background: none;
    border: 0;
    border-bottom: 1px solid var(--line);
    padding: 4px 0 8px;
    margin: 0;
  }
  h2.title {
    padding-bottom: 8px;
  }
  .body {
    font: inherit;
    font-size: 13.5px;
    line-height: 1.6;
    color: var(--ink);
    background: none;
    border: 0;
    resize: vertical;
    margin: 0;
    white-space: pre-wrap;
  }
  textarea {
    font: inherit;
    font-size: 13px;
    line-height: 1.55;
    color: var(--ink);
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 8px 10px;
    resize: vertical;
  }
  textarea.body {
    background: none;
    border: 0;
    padding: 0;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 13px;
  }
  .row.who {
    color: var(--ink-2);
  }
  .lab {
    width: 64px;
    flex: none;
    font-size: 12px;
    color: var(--muted);
  }
  .reply {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .reply .lab {
    width: auto;
  }
  .note {
    font-size: 12px;
    color: var(--muted);
    line-height: 1.5;
  }
  .foot {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .ghost {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 10px;
    border-radius: 7px;
    border: 1px solid var(--line-strong);
    background: none;
    color: var(--ink-2);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .ghost:hover {
    color: var(--ink);
    border-color: var(--ink);
  }
  .ghost.danger:hover {
    color: var(--danger);
    border-color: var(--danger);
  }
  .primary {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 12px;
    border-radius: 7px;
    border: 0;
    background: var(--ink);
    color: var(--bg);
    font: inherit;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
  }
  .primary:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .plist {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
  .plist li {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 0;
    border-bottom: 1px solid var(--line);
    font-size: 13px;
  }
  .plist .t {
    flex: 1;
  }
  .mono {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
  }
</style>
