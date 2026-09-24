<script lang="ts">
  // The action items in a meeting's notes, as things the board can hold. Each
  // is a "- [ ] …" line, the way the write-up puts them, with whoever owns it
  // after an @. Add to board makes the card, files it with the meeting, hands
  // it to that person, and writes the card's ref back into the line, so the
  // notes say which card it became and it is never made twice.
  import Columns3 from '@lucide/svelte/icons/columns-3'
  import Face from './Face.svelte'
  import { v2, type Meeting, type Card } from './api'
  import { ui, go, visibleTabs } from './state.svelte'

  let { meeting, canEdit, onnotes }: { meeting: Meeting; canEdit: boolean; onnotes: (md: string) => void } = $props()

  type Item = { line: number; text: string; owner: string | null; done: boolean; ref: string | null }
  const LINE = /^(\s*[-*]\s+\[)( |x|X)(\]\s+)(.+)$/
  const REF = /\s+→\s+([A-Z]{2,5}-\d+)\s*$/
  const items = $derived.by((): Item[] => {
    const out: Item[] = []
    meeting.notes.split('\n').forEach((raw, i) => {
      const m = LINE.exec(raw)
      if (!m) return
      let text = m[4].trim()
      const ref = REF.exec(text)?.[1] ?? null
      text = text.replace(REF, '')
      const owner = /(?:^|\s)@([A-Za-z][\w.-]*)/.exec(text)?.[1] ?? null
      text = text.replace(/\s*@[A-Za-z][\w.-]*/g, '').replace(/\s*\(due [^)]*\)\s*$/, '').trim()
      out.push({ line: i, text, owner, done: m[2] !== ' ', ref })
    })
    return out
  })
  const person = (owner: string | null) => (owner ? ui.members.find((p) => p.name.toLowerCase() === owner.toLowerCase() || p.name.toLowerCase().split(' ')[0] === owner.toLowerCase()) ?? null : null)
  const boardTab = () => visibleTabs().find((t) => t.type === 'board')?.id

  let busy = $state<Set<number>>(new Set())
  async function add(it: Item) {
    if (it.ref || busy.has(it.line)) return
    busy = new Set([...busy, it.line])
    try {
      // This week's Todo, so it is on the board the moment you look.
      const card = await v2.post<Card>('/cards', { title: it.text, status: 'todo' })
      const who = person(it.owner)
      const patch: Record<string, unknown> = { body: `From the meeting “${meeting.title}”${it.owner && !who ? `, for ${it.owner}` : ''}.` }
      if (who) patch.assigneeId = who.id
      await v2.patch(`/cards/${card.id}`, patch)
      // Where the meeting is, the card goes too.
      if (meeting.project !== undefined) await v2.post('/projects/assign', { kind: 'card', ids: [card.id], project: meeting.project ?? null }).catch(() => {})
      const lines = meeting.notes.split('\n')
      lines[it.line] = `${lines[it.line].replace(/\s+$/, '')} → ${card.ref}`
      onnotes(lines.join('\n'))
    } catch (e) {
      ui.error = (e as Error).message
    } finally {
      busy = new Set([...busy].filter((l) => l !== it.line))
    }
  }
  async function addAll() {
    for (const it of items) if (!it.ref && !it.done) await add(it)
  }
  const openCard = (ref: string) => {
    const tab = boardTab()
    if (tab) go(tab, ref)
  }
  const left = $derived(items.filter((i) => !i.ref && !i.done).length)
</script>

{#if items.length}
  <section class="ai">
    <div class="top">
      <Columns3 size={13} />
      <b>Action items</b>
      <span class="n">{items.length}{left ? ` · ${left} not on the board yet` : ' · all on the board'}</span>
      {#if canEdit && left > 1}<button class="ghost sm" onclick={addAll}>Add all to board</button>{/if}
    </div>
    <ul>
      {#each items as it (it.line)}
        {@const who = person(it.owner)}
        <li class:done={it.done}>
          <span class="t">{it.text}</span>
          {#if who}<span class="who"><Face person={who} size={16} /><span>{who.name.split(' ')[0]}</span></span>
          {:else if it.owner}<span class="who plain">@{it.owner}</span>{/if}
          {#if it.ref}
            <button class="ref" onclick={() => openCard(it.ref!)}>{it.ref}</button>
          {:else if canEdit}
            <button class="ghost sm" disabled={busy.has(it.line)} onclick={() => add(it)}>{busy.has(it.line) ? 'Adding…' : 'Add to board'}</button>
          {/if}
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .ai {
    margin: 0 0 18px;
    border: 1px solid var(--line);
    border-radius: var(--r-lg);
    background: var(--panel);
  }
  .top {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--line);
    font-size: 12px;
    color: var(--ink-2);
  }
  .top b {
    color: var(--ink);
    font-weight: 600;
  }
  .n {
    color: var(--muted);
    flex: 1;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 4px 0;
  }
  li {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 12px;
    font-size: 13px;
  }
  li.done .t {
    color: var(--muted);
    text-decoration: line-through;
  }
  .t {
    flex: 1;
    min-width: 0;
  }
  .who {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--ink-2);
    flex: none;
  }
  .who.plain {
    color: var(--muted);
  }
  .ref {
    font-family: var(--mono);
    font-size: 11px;
    padding: 2px 7px;
    border-radius: 5px;
    border: 1px solid var(--line-strong);
    background: var(--raised);
    color: var(--ink);
    cursor: pointer;
  }
  .ghost.sm {
    height: 24px;
    padding: 0 9px;
    font-size: 12px;
    border-radius: 6px;
    border: 1px solid var(--line-strong);
    background: none;
    color: var(--ink-2);
    cursor: pointer;
    font: inherit;
    font-size: 12px;
  }
  .ghost.sm:hover {
    color: var(--ink);
    border-color: var(--ink);
  }
</style>
