<script lang="ts">
  // ⌘K: find any card, doc, canvas or meeting in this workspace, or ask it a
  // question. Asking searches everything written down and has Claude Code
  // answer from the passages, on this Mac, saying what each claim came from.
  import Search from '@lucide/svelte/icons/search'
  import Sparkles from '@lucide/svelte/icons/sparkles'
  import CornerDownLeft from '@lucide/svelte/icons/corner-down-left'
  import FileText from '@lucide/svelte/icons/file-text'
  import Columns3 from '@lucide/svelte/icons/columns-3'
  import Shapes from '@lucide/svelte/icons/shapes'
  import Mic from '@lucide/svelte/icons/mic'
  import { v2, type Card, type DocSummary, type CanvasSummary, type MeetingSummary } from './api'
  import { ui, go } from './state.svelte'
  import { takeFocus } from './focus'

  let { onclose }: { onclose: () => void } = $props()
  type Kind = 'card' | 'doc' | 'canvas' | 'meeting'
  type Hit = { kind: Kind; id: string; title: string; sub: string }
  type Citation = { kind: Kind; itemId: string; title: string; heading?: string }
  type Answer = { answer: string; citations: Citation[]; used: number; model: string }
  let all = $state<Hit[]>([])
  let q = $state('')
  let idx = $state(0)
  let asking = $state(false)
  let answer = $state<Answer | null>(null)

  /**
   * The answer comes back as Markdown, because that is how a model writes.
   * Bold, `code` and bullets are the only things it reaches for, so those are
   * the only things drawn; anything else stays as it was typed rather than
   * showing its own asterisks.
   */
  function said(md: string) {
    return md
      .split('\n')
      .map((raw) => raw.trim())
      .filter(Boolean)
      .map((line) => {
        const bullet = /^([-*]|\d+\.)\s+/.test(line)
        const text = bullet ? line.replace(/^([-*]|\d+\.)\s+/, '') : line
        const parts = text
          .split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
          .filter(Boolean)
          .map((t) =>
            t.startsWith('**') && t.endsWith('**')
              ? { t: t.slice(2, -2), b: true, c: false }
              : t.startsWith('`') && t.endsWith('`')
                ? { t: t.slice(1, -1), b: false, c: true }
                : { t, b: false, c: false },
          )
        return { bullet, parts }
      })
  }
  let askError = $state('')

  /** A question, rather than a name to find. */
  const looksLikeQuestion = $derived(/\?\s*$/.test(q) || /^(who|what|when|where|why|how|did|do|does|is|are|can|should|which)\b/i.test(q.trim()))

  async function askIt() {
    const question = q.trim()
    if (!question || asking) return
    asking = true
    answer = null
    askError = ''
    try {
      answer = await v2.post<Answer>('/ask', { question })
    } catch (e) {
      askError = (e as Error).message
    }
    asking = false
  }

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

      <input
        use:takeFocus
        placeholder="Search, or ask this workspace a question"
        bind:value={q}
        oninput={() => (idx = 0)}
        onkeydown={(e) => {
          if (e.key === 'ArrowDown') ((idx = Math.min(idx + 1, shown.length - 1)), e.preventDefault())
          if (e.key === 'ArrowUp') ((idx = Math.max(idx - 1, 0)), e.preventDefault())
          if (e.key === 'Enter' && (e.metaKey || looksLikeQuestion || !shown.length)) (askIt(), e.preventDefault())
          else if (e.key === 'Enter' && shown[idx]) open(shown[idx])
          if (e.key === 'Escape') onclose()
        }}
      />
    </label>
    {#if q.trim()}
      <button class="ask" onclick={askIt} disabled={asking}>
        <Sparkles size={13} />
        <span class="t">{asking ? 'Asking the workspace…' : `Ask: ${q.trim()}`}</span>
        <kbd>{looksLikeQuestion || !shown.length ? '↵' : '⌘↵'}</kbd>
      </button>
    {/if}

    {#if answer || askError}
      <div class="answer">
        {#if askError}
          <p class="err">{askError}</p>
        {:else if answer}
          <div class="text">
            {#each said(answer.answer) as line}
              {#if line.bullet}
                <p class="bullet">{#each line.parts as t}{#if t.b}<b>{t.t}</b>{:else if t.c}<code>{t.t}</code>{:else}{t.t}{/if}{/each}</p>
              {:else}
                <p>{#each line.parts as t}{#if t.b}<b>{t.t}</b>{:else if t.c}<code>{t.t}</code>{:else}{t.t}{/if}{/each}</p>
              {/if}
            {/each}
          </div>
          {#if answer.citations.length}
            <div class="cites">
              {#each answer.citations as c (c.kind + c.itemId)}
                {@const Icon = ICON[c.kind]}
                <button class="cite" onclick={() => open({ kind: c.kind, id: c.itemId, title: c.title, sub: '' })}>
                  <Icon size={12} /><span>{c.title}</span>
                </button>
              {/each}
            </div>
          {/if}
          <span class="by">{answer.used} passages · {answer.model}</span>
        {/if}
      </div>
    {/if}

    <div class="list">
      {#each shown as h, i (h.kind + h.id)}
        {@const Icon = ICON[h.kind]}
        <button class:on={i === idx} onmouseenter={() => (idx = i)} onclick={() => open(h)}>
          <Icon size={14} /><span class="t">{h.title}</span><span class="s">{h.sub}</span>
        </button>
      {:else}
        <p>{all.length ? (answer ? '' : 'Nothing matches by name. Press ↵ to ask instead.') : 'Loading…'}</p>
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
  .ask {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    height: 40px;
    padding: 0 16px;
    border: 0;
    border-bottom: 1px solid var(--line);
    background: none;
    color: var(--ink);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
    text-align: left;
  }
  .ask:hover:not(:disabled) {
    background: var(--accent-soft);
  }
  .ask .t {
    flex: 1;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  kbd {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
  }
  .text p {
    margin: 0 0 8px;
  }
  .text p:last-child {
    margin-bottom: 0;
  }
  .text .bullet {
    padding-left: 16px;
    position: relative;
    margin-bottom: 4px;
  }
  .text .bullet::before {
    content: '';
    position: absolute;
    left: 4px;
    top: 9px;
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: var(--muted);
  }
  .text b {
    font-weight: 600;
    color: var(--ink);
  }
  .text code {
    font-family: var(--mono);
    font-size: 12.5px;
    background: var(--raised);
    border: 1px solid var(--line);
    border-radius: var(--r-sm);
    padding: 1px 5px;
  }
  .answer {
    padding: 12px 16px;
    border-bottom: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-height: 320px;
    overflow: auto;
  }
  .text {
    margin: 0;
    font-size: 13px;
    line-height: 1.55;
    color: var(--ink);
  }
  .cites {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .cite {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 24px;
    padding: 0 8px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: none;
    color: var(--ink-2);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    max-width: 220px;
  }
  .cite:hover {
    border-color: var(--line-strong);
    color: var(--ink);
  }
  .cite span {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .by {
    font-size: var(--fs-1);
    color: var(--muted);
  }
  .err {
    margin: 0;
    font-size: 12px;
    color: var(--danger);
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
