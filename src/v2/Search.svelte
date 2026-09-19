<script lang="ts">
  // ⌘K: find any card, doc, canvas or meeting in this workspace.
  import Search from '@lucide/svelte/icons/search'
  import FileText from '@lucide/svelte/icons/file-text'
  import Columns3 from '@lucide/svelte/icons/columns-3'
  import Shapes from '@lucide/svelte/icons/shapes'
  import Mic from '@lucide/svelte/icons/mic'
  import { v2, type Card, type DocSummary, type CanvasSummary, type MeetingSummary } from './api'
  import { ui, go } from './state.svelte'

  let { onclose }: { onclose: () => void } = $props()
  type Hit = { kind: 'card' | 'doc' | 'canvas' | 'meeting'; id: string; title: string; sub: string }
  let all = $state<Hit[]>([])
  let q = $state('')
  let idx = $state(0)

  const tabOf = (type: string) => ui.settings?.tabs.find((t) => t.type === type && !t.hidden)?.id ?? type
  Promise.allSettled([
    v2.get<Card[]>('/cards'),
    v2.get<DocSummary[]>('/docs'),
    v2.get<CanvasSummary[]>('/canvases'),
    v2.get<MeetingSummary[]>('/meetings'),
  ]).then(([c, d, v, m]) => {
    const hits: Hit[] = []
    if (c.status === 'fulfilled') hits.push(...c.value.map((x) => ({ kind: 'card' as const, id: x.id, title: x.title, sub: x.ref })))
    if (d.status === 'fulfilled') hits.push(...d.value.map((x) => ({ kind: 'doc' as const, id: x.id, title: x.title, sub: 'Doc' })))
    if (v.status === 'fulfilled') hits.push(...v.value.map((x) => ({ kind: 'canvas' as const, id: x.id, title: x.title, sub: 'Canvas' })))
    if (m.status === 'fulfilled') hits.push(...m.value.map((x) => ({ kind: 'meeting' as const, id: x.id, title: x.title, sub: 'Meeting' })))
    all = hits
  })

  const shown = $derived((q.trim() ? all.filter((h) => `${h.title} ${h.sub}`.toLowerCase().includes(q.trim().toLowerCase())) : all).slice(0, 12))
  const ICON = { card: Columns3, doc: FileText, canvas: Shapes, meeting: Mic }

  function open(h: Hit) {
    if (h.kind === 'card') go(tabOf('board'))
    else go(tabOf(h.kind === 'doc' ? 'docs' : h.kind === 'canvas' ? 'canvas' : 'meetings'), h.id)
    onclose()
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="scrim" onclick={onclose}>
  <div class="box" onclick={(e) => e.stopPropagation()}>
    <label class="in">
      <Search size={15} />
      <!-- svelte-ignore a11y_autofocus -->
      <input
        autofocus
        placeholder="Search cards, docs, canvases and meetings"
        bind:value={q}
        oninput={() => (idx = 0)}
        onkeydown={(e) => {
          if (e.key === 'ArrowDown') ((idx = Math.min(idx + 1, shown.length - 1)), e.preventDefault())
          if (e.key === 'ArrowUp') ((idx = Math.max(idx - 1, 0)), e.preventDefault())
          if (e.key === 'Enter' && shown[idx]) open(shown[idx])
          if (e.key === 'Escape') onclose()
        }}
      />
    </label>
    <div class="list">
      {#each shown as h, i (h.kind + h.id)}
        {@const Icon = ICON[h.kind]}
        <button class:on={i === idx} onmouseenter={() => (idx = i)} onclick={() => open(h)}>
          <Icon size={14} /><span class="t">{h.title}</span><span class="s">{h.sub}</span>
        </button>
      {:else}
        <p>{all.length ? 'Nothing matches.' : 'Loading…'}</p>
      {/each}
    </div>
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    justify-content: center;
    padding-top: 14vh;
    z-index: 80;
  }
  .box {
    width: 600px;
    align-self: flex-start;
    background: var(--raised);
    border: 1px solid var(--line-strong);
    border-radius: 12px;
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.6);
    overflow: hidden;
  }
  .in {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 16px;
    height: 50px;
    border-bottom: 1px solid var(--line-strong);
    color: var(--muted);
  }
  input {
    flex: 1;
    background: none;
    border: 0;
    outline: none;
    color: var(--ink);
    font: inherit;
    font-size: 15px;
  }
  .list {
    padding: 6px;
    max-height: 400px;
    overflow: auto;
  }
  button {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 10px;
    height: 36px;
    padding: 0 10px;
    border: 0;
    border-radius: 6px;
    background: none;
    color: var(--ink-2);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
    text-align: left;
  }
  button.on {
    background: #242424;
    color: var(--ink);
  }
  .t {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .s {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
  }
  p {
    font-size: 13px;
    color: var(--muted);
    padding: 12px;
    margin: 0;
  }
</style>
