<script lang="ts">
  // Docs: a home page of everything written, and each doc opening full width.
  import ProjectChip from './ProjectChip.svelte'
  import ProjectPicker from './ProjectPicker.svelte'
  import { scope } from './project.svelte'
  import Plus from '@lucide/svelte/icons/plus'
  import Search from '@lucide/svelte/icons/search'
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
  const recent = $derived(shown.slice(0, 3))

  /** The first lines of each recent doc, for a thumbnail of the page itself. */
  let previews = $state<Record<string, { kind: 'h1' | 'h2' | 'li' | 'p'; text: string }[]>>({})
  function lines(md: string) {
    const out: { kind: 'h1' | 'h2' | 'li' | 'p'; text: string }[] = []
    for (const raw of md.split('\n')) {
      const l = raw.trim()
      if (!l || /^(```|---|!\[)/.test(l)) continue
      const clean = (t: string) => t.replace(/[*_`]|\[([^\]]*)\]\([^)]*\)/g, (m, g) => g ?? '')
      if (l.startsWith('# ')) out.push({ kind: 'h1', text: clean(l.slice(2)) })
      else if (/^#{2,6} /.test(l)) out.push({ kind: 'h2', text: clean(l.replace(/^#+ /, '')) })
      else if (/^([-*]|\d+\.)( \[.\])? /.test(l)) out.push({ kind: 'li', text: clean(l.replace(/^([-*]|\d+\.)( \[.\])? /, '')) })
      else out.push({ kind: 'p', text: clean(l) })
      if (out.length >= 9) break
    }
    return out
  }
  // Only `recent` is read here; which docs were already asked for lives in a
  // plain Set, so the effect never re-runs off its own writes.
  const asked = new Set<string>()
  $effect(() => {
    for (const d of recent) {
      // Keyed by the edit time, so a doc edited since it was last drawn is drawn again.
      const key = `${d.id}@${d.updatedAt}`
      if (asked.has(key)) continue
      asked.add(key)
      const have = peek<Doc>(`/docs/${d.id}`)
      if (have && have.updatedAt === d.updatedAt) previews = { ...previews, [d.id]: lines(have.body) }
      fetchCached<Doc>(`/docs/${d.id}`)
        .then((full) => (previews = { ...previews, [d.id]: lines(full.body) }))
        .catch(() => {})
    }
  })

  async function create() {
    try {
      const d = await v2.post<Doc>('/docs', { title: 'Untitled' })
      docs = [d, ...docs]
      go(tabId, d.id)
    } catch (e) {
      ui.error = (e as Error).message
    }
  }

  function queue(patch: Partial<Pick<Doc, 'title' | 'body'>>) {
    if (!doc) return
    doc = { ...doc, ...patch }
    saving = 'saving'
    clearTimeout(timer)
    timer = setTimeout(save, 700)
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
        <CopyNode text={() => `# ${doc!.title}\n\n${doc!.body}`} size={13} />
        <button class="del" title="Delete doc" onclick={remove}><Trash2 size={13} /></button>
      {/if}
    </Header>
    <div class="scroll">
      <article>
        {#if doc}
          <input class="dtitle" value={doc.title} placeholder="Untitled" oninput={(e) => queue({ title: e.currentTarget.value })} />
          <ProjectPicker kind="doc" id={doc.id} project={doc.project ?? null} onchange={(p) => (doc && (doc.project = p), (docs = docs.map((x) => (x.id === doc?.id ? { ...x, project: p } : x))))} />
          {#key doc.id}
            <DocEditor value={doc.body} onchange={(md) => queue({ body: md })} />
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
      <button class="primary" onclick={create}><Plus size={12} /><span>New doc</span></button>
    </Header>
    <div class="scroll">
      <div class="home">
        <div class="top">
          <h1>{tabName}</h1>
          <label class="find"><Search size={13} /><input placeholder="Search docs" bind:value={query} /></label>
        </div>

        {#if loading && !docs.length}
          <div class="recent">
            {#each [0, 1, 2] as _}<div class="dcard sk"><div class="thumb"></div><div class="info"><Skeleton w="70%" h={12} /><Skeleton w="40%" h={10} /></div></div>{/each}
          </div>
        {:else if recent.length}
          <div class="recent">
            {#each recent as d (d.id)}
              <button class="dcard" onclick={() => go(tabId, d.id)} onmouseenter={() => prefetch(`/docs/${d.id}`)}>
                <div class="thumb">
                  <div class="paper">
                    <span class="pt">{d.title}</span>
                    {#each previews[d.id] ?? [] as l}
                      <span class="pl {l.kind}">{l.kind === 'li' ? '• ' : ''}{l.text}</span>
                    {/each}
                  </div>
                </div>
                <div class="info">
                  <span class="t">{d.title}</span>
                  <span class="s">Edited {ago(d.updatedAt)}</span>
                </div>
              </button>
            {/each}
          </div>
        {/if}

        <div class="list">
          <div class="lh"><span class="grow">All docs</span><span class="w120">{scope.enabled && !scope.id ? 'Project' : 'Folder'}</span><span class="w110 r">Edited</span></div>
          {#each shown as d (d.id)}
            <button class="row" onclick={() => go(tabId, d.id)} onmouseenter={() => prefetch(`/docs/${d.id}`)}>
              <FileText size={14} />
              <span class="grow t">{d.title}</span>
              <span class="w120 dim">
                {#if scope.enabled}
                  <ProjectChip kind="doc" id={d.id} project={d.project ?? null} onmoved={(p) => (docs = docs.map((x) => (x.id === d.id ? { ...x, project: p } : x)))} />
                {:else}{d.folder ?? ''}{/if}
              </span>
              <span class="w110 r dim">{ago(d.updatedAt)}</span>
            </button>
          {:else}
            {#if loading}
              {#each [0, 1, 2, 3] as _}<div class="row sk"><Skeleton w={14} h={14} /><Skeleton w="45%" h={12} /></div>{/each}
            {:else}
              <p class="empty">
              {#if query}Nothing matches that search.
              {:else if scope.enabled && scope.id}Nothing here yet. New docs land in this project; to move an existing one, switch to All projects and use its project chip.
              {:else}No docs yet. Start one with New doc.{/if}
            </p>
            {/if}
          {/each}
        </div>
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
    justify-content: space-between;
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
  .recent {
    display: flex;
    gap: 16px;
  }
  .dcard {
    flex: 1;
    max-width: 310px;
    display: flex;
    flex-direction: column;
    border-radius: 10px;
    border: 1px solid var(--line-strong);
    overflow: hidden;
    background: none;
    padding: 0;
    color: inherit;
    font: inherit;
    cursor: pointer;
    text-align: left;
  }
  .dcard:hover {
    border-color: #3a3a3a;
  }
  .thumb {
    height: 150px;
    background: var(--raised);
    overflow: hidden;
    position: relative;
  }
  /* The page itself, set at page size and shrunk: a literal thumbnail. */
  .paper {
    position: absolute;
    left: 22px;
    top: 18px;
    width: 640px;
    transform: scale(0.42);
    transform-origin: top left;
    display: flex;
    flex-direction: column;
    gap: 10px;
    pointer-events: none;
  }
  .pt {
    font-size: 36px;
    font-weight: 600;
    letter-spacing: -0.03em;
    line-height: 1.15;
    color: var(--ink);
  }
  .pl {
    font-size: 15px;
    line-height: 1.55;
    color: var(--ink-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .pl.h1,
  .pl.h2 {
    font-size: 20px;
    font-weight: 600;
    color: var(--ink);
    margin-top: 6px;
  }
  .info {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 12px 14px;
    border-top: 1px solid var(--line);
  }
  .info .t {
    font-size: 14px;
    font-weight: 600;
  }
  .info .s {
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
