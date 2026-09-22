<script lang="ts">
  // Docs: a home page of everything written, and each doc opening full width.
  import { canEditHere, afterMove } from './project.svelte'
  import ProjectChip from './ProjectChip.svelte'
  import ItemMenu from './ItemMenu.svelte'
  import { scope } from './project.svelte'
  import Plus from '@lucide/svelte/icons/plus'
  import Search from '@lucide/svelte/icons/search'
  import LayoutGrid from '@lucide/svelte/icons/layout-grid'
  import List from '@lucide/svelte/icons/list'
  import FileText from '@lucide/svelte/icons/file-text'
  import Trash2 from '@lucide/svelte/icons/trash-2'
  import Header from './Header.svelte'
  import CopyNode from './CopyNode.svelte'
  import DocEditor from '../lib/DocEditor.svelte'
  import { v2, ago, type Doc, type DocSummary } from './api'
  import { ui, go } from './state.svelte'
  import Skeleton from './Skeleton.svelte'
  import { peek, load as fetchCached, put, prefetch } from './cache'

  let { tabId, tabName = 'Docs' }: { tabId: string; tabName?: string } = $props()

  let docs = $state<DocSummary[]>(peek<DocSummary[]>('/docs') ?? [])
  let query = $state('')
  let loading = $state(!peek('/docs'))
  let doc = $state<Doc | null>(null)
  let saving = $state<'idle' | 'saving' | 'saved' | 'conflict'>('idle')
  let timer: ReturnType<typeof setTimeout> | undefined

  async function load() {
    loading = true
    try {
      docs = await fetchCached<DocSummary[]>('/docs')
    } catch (e) {
      ui.error = (e as Error).message
    }
    loading = false
  }
  load()

  $effect(() => {
    const id = ui.item
    if (!id) {
      doc = null
      return
    }
    saving = 'idle'
    doc = peek<Doc>(`/docs/${id}`) ?? null
    fetchCached<Doc>(`/docs/${id}`)
      .then((d) => {
        // Never clobber what is being typed; only fill in a doc not yet shown.
        if (ui.item === id && (!doc || doc.id !== id || saving === 'idle')) doc = d
      })
      .catch((e) => (ui.error = (e as Error).message))
  })

  const shown = $derived(query.trim() ? docs.filter((d) => d.title.toLowerCase().includes(query.trim().toLowerCase())) : docs)
  /**
   * How the home page lists what is written: tiles, or a table. No page
   * previews either way -- a wall of tiny grey lines is decoration, and the
   * title is what anyone actually looks for.
   */
  let view = $state<'grid' | 'list'>(
    (() => {
      try {
        return localStorage.getItem('alfredo.v2.docsview') === 'list' ? 'list' : 'grid'
      } catch {
        return 'grid' as const
      }
    })(),
  )
  const empty = $derived(
    query.trim()
      ? 'Nothing matches that search.'
      : scope.enabled && scope.id
        ? 'Nothing here yet. New docs land in this project; to move an existing one, open the project it is in (or Unfiled) and use its three dots.'
        : 'No docs yet. Start one with New doc.',
  )

  function setView(v: 'grid' | 'list') {
    view = v
    try {
      localStorage.setItem('alfredo.v2.docsview', v)
    } catch {}
  }

  /**
   * A doc just made has a placeholder name and a blank page. Put the cursor
   * in the name with "Untitled" selected, so the first thing typed names it
   * and Enter moves on to the writing.
   */
  let fresh = $state<string | null>(null)
  let editor = $state<{ focus: (atEnd?: boolean) => void } | null>(null)
  let titleEl = $state<HTMLInputElement | null>(null)

  async function create() {
    try {
      const d = await v2.post<Doc>('/docs', { title: 'Untitled' })
      docs = [d, ...docs]
      fresh = d.id
      go(tabId, d.id)
    } catch (e) {
      ui.error = (e as Error).message
    }
  }

  $effect(() => {
    if (!doc || fresh !== doc.id || !titleEl) return
    const el = titleEl
    requestAnimationFrame(() => {
      el.focus()
      el.select()
    })
    fresh = null
  })

  function queue(patch: Partial<Pick<Doc, 'title' | 'body'>>) {
    if (!doc) return
    doc = { ...doc, ...patch }
    saving = 'saving'
    clearTimeout(timer)
    timer = setTimeout(save, 700)
  }
  /** From a doc's three dots in the grid or the list. */
  async function removeFromList(d: { id: string; title: string }) {
    if (!confirm(`Delete “${d.title || 'Untitled'}”?`)) return
    const before = docs
    docs = docs.filter((x) => x.id !== d.id)
    put('/docs', docs)
    try {
      await v2.del(`/docs/${d.id}`)
    } catch (e) {
      docs = before
      put('/docs', before)
      ui.error = (e as Error).message
    }
  }
  const movedTo = (id: string, p: string | null) => {
    docs = afterMove(docs, id, p)
    put('/docs', docs)
  }

  async function remove() {
    if (!doc || !confirm(`Delete “${doc.title || 'Untitled'}”?`)) return
    const id = doc.id
    const before = docs
    docs = docs.filter((d) => d.id !== id)
    put('/docs', docs)
    go(tabId)
    try {
      await v2.del(`/docs/${id}`)
    } catch (e) {
      docs = before
      put('/docs', before)
      ui.error = (e as Error).message
    }
  }

  async function save() {
    if (!doc) return
    const d = doc
    try {
      const next = await v2.put<Doc>(`/docs/${d.id}`, { title: d.title, body: d.body, revision: d.revision })
      if (doc?.id === next.id) doc = { ...doc, revision: next.revision, updatedAt: next.updatedAt }
      put(`/docs/${next.id}`, doc?.id === next.id ? doc : next)
      docs = docs.map((x) => (x.id === next.id ? { ...x, title: next.title, updatedAt: next.updatedAt } : x))
      saving = 'saved'
    } catch (e) {
      const m = (e as Error).message
      saving = /changed|updated|reload/i.test(m) ? 'conflict' : 'idle'
      ui.error = m
    }
  }
</script>

{#if ui.item}
  <div class="page">
    <Header crumbs={[{ label: tabName, onclick: () => go(tabId) }, doc?.title || docs.find((d) => d.id === ui.item)?.title || 'Untitled']}>
      {#if doc}
        <span class="state">{saving === 'saving' ? 'Saving…' : saving === 'conflict' ? 'Changed elsewhere: reload' : `Edited ${ago(doc.updatedAt)}`}</span>
        <CopyNode text={() => doc!.body} as={{ kind: 'doc', id: doc!.id, title: doc!.title }} size={13} />
        <button class="del" title="Delete doc" onclick={remove}><Trash2 size={13} /></button>
      {/if}
    </Header>
    <!-- Clicking the page anywhere puts the cursor back in the writing, the
         way paper would; the editor itself is only as tall as its text. -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="scroll" onclick={(e) => (e.target as HTMLElement).closest('.scroll') === e.target && editor?.focus(true)}>
      <article>
        {#if doc}
          <input
            class="dtitle"
            bind:this={titleEl}
            value={doc.title}
            placeholder="Untitled"
            oninput={(e) => queue({ title: e.currentTarget.value })}
            onkeydown={(e) => {
              // Enter (or Tab) from the name goes to the writing, as it should.
              if (e.key === 'Enter' || e.key === 'Tab') (e.preventDefault(), editor?.focus(true))
            }}
          />
          {#key doc.id}
            <DocEditor bind:this={editor} value={doc.body} onchange={(md) => queue({ body: md })} />
          {/key}
        {:else}
          <div class="skel">
            <Skeleton w="60%" h={34} r={6} />
            <Skeleton w="92%" h={13} /><Skeleton w="85%" h={13} /><Skeleton w="70%" h={13} />
            <Skeleton w="40%" h={20} r={5} />
            <Skeleton w="90%" h={13} /><Skeleton w="78%" h={13} />
          </div>
        {/if}
      </article>
    </div>
  </div>
{:else}
  <div class="page">
    <Header crumbs={[tabName]}>
      {#if canEditHere()}<button class="primary" onclick={create}><Plus size={12} /><span>New doc</span></button>{/if}
    </Header>
    <div class="scroll">
      <div class="home">
        <div class="top">
          <h1>{tabName}</h1>
          <label class="find"><Search size={13} /><input placeholder="Search docs" bind:value={query} /></label>
          <div class="seg" role="group" aria-label="How docs are listed">
            <button class:on={view === 'grid'} title="Grid" aria-label="Grid" onclick={() => setView('grid')}><LayoutGrid size={13} /></button>
            <button class:on={view === 'list'} title="List" aria-label="List" onclick={() => setView('list')}><List size={13} /></button>
          </div>
        </div>

        {#if view === 'grid'}
          <div class="grid">
            {#each shown as d (d.id)}
              <button class="tile" onclick={() => go(tabId, d.id)} onmouseenter={() => prefetch(`/docs/${d.id}`)}>
                <span class="top">
                  <FileText size={15} />
                  {#if canEditHere()}<span class="more"><ItemMenu kind="doc" id={d.id} project={d.project ?? null} onopen={() => go(tabId, d.id)} onmoved={(p) => movedTo(d.id, p)} ondelete={() => removeFromList(d)} /></span>{/if}
                </span>
                <span class="t">{d.title}</span>
                <span class="s">
                  {#if scope.enabled}
                    <ProjectChip passive kind="doc" id={d.id} project={d.project ?? null} />
                  {:else if d.folder}{d.folder} ·{/if}
                  Edited {ago(d.updatedAt)}
                </span>
              </button>
            {:else}
              {#if loading}
                {#each [0, 1, 2, 3, 4, 5] as _}<div class="tile sk"><Skeleton w={15} h={15} r={4} /><Skeleton w="70%" h={12} /><Skeleton w="40%" h={10} /></div>{/each}
              {:else}
                <p class="empty">{empty}</p>
              {/if}
            {/each}
          </div>
        {:else}
          <div class="list">
            <div class="lh"><span class="grow">All docs</span><span class="w120">{scope.enabled && !scope.id ? 'Project' : 'Folder'}</span><span class="w110 r">Edited</span>{#if canEditHere()}<span class="w24"></span>{/if}</div>
            {#each shown as d (d.id)}
              <button class="row" onclick={() => go(tabId, d.id)} onmouseenter={() => prefetch(`/docs/${d.id}`)}>
                <FileText size={14} />
                <span class="grow t">{d.title}</span>
                <span class="w120 dim">
                  {#if scope.enabled}
                    <ProjectChip passive kind="doc" id={d.id} project={d.project ?? null} />
                  {:else}{d.folder ?? ''}{/if}
                </span>
                <span class="w110 r dim">{ago(d.updatedAt)}</span>
                {#if canEditHere()}<span class="more"><ItemMenu kind="doc" id={d.id} project={d.project ?? null} onopen={() => go(tabId, d.id)} onmoved={(p) => movedTo(d.id, p)} ondelete={() => removeFromList(d)} /></span>{/if}
              </button>
            {:else}
              {#if loading}
                {#each [0, 1, 2, 3] as _}<div class="row sk"><Skeleton w={14} h={14} /><Skeleton w="45%" h={12} /></div>{/each}
              {:else}
                <p class="empty">{empty}</p>
              {/if}
            {/each}
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .page {
    height: 100%;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .scroll {
    flex: 1;
    overflow: auto;
  }
  .home {
    max-width: 960px;
    margin: 0 auto;
    padding: 48px;
    display: flex;
    flex-direction: column;
    gap: 32px;
  }
  .top {
    display: flex;
    align-items: flex-end;
    gap: 12px;
  }
  .top .find {
    margin-left: auto;
  }
  h1 {
    margin: 0;
    font-size: 32px;
    font-weight: 600;
    letter-spacing: -0.03em;
  }
  .find {
    width: 280px;
    height: 32px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 10px;
    border-radius: var(--r-md);
    background: var(--panel);
    border: 1px solid var(--line-strong);
    color: var(--muted);
  }
  .find input {
    flex: 1;
    background: none;
    border: 0;
    outline: none;
    color: var(--ink);
    font: inherit;
    font-size: 13px;
  }
  .seg {
    display: flex;
    gap: 2px;
    padding: 2px;
    border-radius: var(--r-md);
    border: 1px solid var(--line-strong);
    background: var(--panel);
    height: 32px;
    box-sizing: border-box;
  }
  .seg button {
    width: 30px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: 5px;
    background: none;
    color: var(--muted);
    cursor: pointer;
  }
  .seg button:hover {
    color: var(--ink-2);
  }
  .seg button.on {
    background: var(--raised);
    color: var(--ink);
  }
  .grid {
    display: flex;
    flex-wrap: wrap;
    gap: 14px;
  }
  /* The dots are there when you reach for them, and stay while their menu is open. */
  .top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    align-self: stretch;
    height: 16px;
  }
  .more {
    display: inline-flex;
    opacity: 0;
    transition: opacity 0.12s;
  }
  .tile:hover .more,
  .row:hover .more,
  .more:focus-within,
  .more:has(:global(.open)) {
    opacity: 1;
  }
  .tile .more {
    margin: -4px -6px -4px 0;
  }
  .w24 {
    width: 24px;
    flex: none;
  }
  .tile {
    width: 232px;
    min-height: 104px;
    display: flex;
    flex-direction: column;
    gap: 9px;
    align-items: flex-start;
    padding: 14px 15px;
    border-radius: 10px;
    border: 1px solid var(--line-strong);
    background: none;
    color: var(--muted);
    font: inherit;
    text-align: left;
    cursor: pointer;
    box-sizing: border-box;
  }
  .tile:hover {
    border-color: #3a3a3a;
    background: var(--panel);
  }
  .tile.sk {
    cursor: default;
  }
  .tile .t {
    font-size: 14px;
    font-weight: 600;
    color: var(--ink);
    line-height: 1.35;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .tile .s {
    margin-top: auto;
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--muted);
  }
  .list {
    display: flex;
    flex-direction: column;
  }
  .lh {
    display: flex;
    align-items: center;
    gap: 12px;
    height: 32px;
    border-bottom: 1px solid var(--line);
    font-size: 11px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted);
    font-weight: 500;
    padding-left: 26px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    height: 44px;
    border: 0;
    border-bottom: 1px solid var(--line);
    background: none;
    color: var(--muted);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
    text-align: left;
  }
  .row:hover {
    background: var(--accent-soft);
  }
  .row .t {
    color: var(--ink);
    font-weight: 500;
  }
  .grow {
    flex: 1;
  }
  .w120 {
    width: 120px;
  }
  .w110 {
    width: 110px;
  }
  .r {
    text-align: right;
  }
  .dim {
    color: var(--muted);
    font-size: 12px;
  }
  .empty {
    color: var(--muted);
    font-size: 13px;
    padding: 20px 0;
  }
  .primary {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 10px;
    border-radius: var(--r-md);
    background: var(--ink);
    color: var(--on-accent);
    border: 0;
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }
  .state {
    font-size: 12px;
    color: var(--muted);
  }
  article {
    max-width: 720px;
    margin: 0 auto;
    padding: 56px 48px 120px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .dtitle {
    font: inherit;
    font-size: 36px;
    font-weight: 600;
    letter-spacing: -0.03em;
    background: none;
    border: 0;
    outline: none;
    color: var(--ink);
  }

  .skel {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding-top: 8px;
  }
  .dcard.sk {
    cursor: default;
  }
  .dcard.sk .info {
    gap: 8px;
  }
  .row.sk {
    cursor: default;
  }
  .del {
    background: none;
    border: 0;
    color: var(--muted);
    cursor: pointer;
    display: flex;
    padding: 3px;
    border-radius: 4px;
  }
  .del:hover {
    color: var(--danger);
  }
</style>
