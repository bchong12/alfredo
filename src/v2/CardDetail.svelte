<script lang="ts">
  // A card, opened. Closing applies the changes at once; the board sends them
  // and puts things back only if the server refuses.
  import ProjectPicker from './ProjectPicker.svelte'
  import X from '@lucide/svelte/icons/x'
  import Trash2 from '@lucide/svelte/icons/trash-2'
  import Face from './Face.svelte'
  import CopyNode from './CopyNode.svelte'
  import { STATUSES, weekRange, type Card, type Status, type CyclesView } from './api'
  import { ui } from './state.svelte'

  type Result = { card: Card; patch: Record<string, unknown> } | { removed: string } | null
  let { card, view = null, onclose }: { card: Card; view?: CyclesView | null; onclose: (r: Result) => void } = $props()

  let title = $state(card.title)
  let body = $state(card.body)
  let status = $state<Status>(card.status)
  let assigneeId = $state<string | null>(card.assignee?.id ?? null)
  let week = $state<string>(card.week ?? 'backlog')

  /** The cycle a card's week belongs to, so the picker shows it selected. */
  const cycleOf = (w: string) => view?.cycles.find((c) => c.start <= w && w <= c.end)?.start ?? w
  week = card.week ? cycleOf(card.week) : 'backlog'
  const startWeek = week

  function save() {
    if (card.id.startsWith('tmp-')) return onclose(null)
    const patch: Record<string, unknown> = {}
    const local: Partial<Card> = {}
    if (title.trim() && title !== card.title) patch.title = local.title = title.trim()
    if (body !== card.body) patch.body = local.body = body
    if (status !== card.status) patch.status = local.status = status
    if (assigneeId !== (card.assignee?.id ?? null)) {
      patch.assigneeId = assigneeId
      local.assignee = ui.members.find((m) => m.id === assigneeId) ?? null
    }
    if (week !== startWeek) {
      patch.week = week
      local.week = week === 'backlog' ? null : week
    }
    onclose({ card: { ...card, ...local }, patch })
  }
  function remove() {
    onclose({ removed: card.id })
  }
  const md = () => `# ${card.ref} ${title}\nStatus: ${STATUSES.find((s) => s.id === status)?.label}\n\n${body}`
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && (e.preventDefault(), save())} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="scrim" onclick={save}>
  <div class="sheet" onclick={(e) => e.stopPropagation()}>
    <div class="head">
      <span class="ref">{card.ref}</span>
      <span class="grow"></span>
      <CopyNode text={md} size={13} />
      <button class="icon" title="Archive" onclick={remove}><Trash2 size={14} /></button>
      <button class="icon" title="Close" onclick={save}><X size={15} /></button>
    </div>
    <input class="title" bind:value={title} onkeydown={(e) => e.key === 'Enter' && save()} />
    <div class="row">
      <label>
        <span>Status</span>
        <select bind:value={status}>
          {#each STATUSES as s}<option value={s.id}>{s.label}</option>{/each}
        </select>
      </label>
      <label>
        <span>Assignee</span>
        <select bind:value={assigneeId}>
          <option value={null}>Nobody</option>
          {#each ui.members as m}<option value={m.id}>{m.name}</option>{/each}
        </select>
      </label>
      <label>
        <span>{(view?.settings.length ?? 1) === 1 ? 'Week' : 'Cycle'}</span>
        <select bind:value={week}>
          <option value="backlog">Backlog</option>
          {#each [...(view?.cycles ?? [])].reverse() as c (c.start)}
            <option value={c.start}>{c.label} · {weekRange(c.start, c.end)}{c.current ? ' (current)' : ''}</option>
          {/each}
        </select>
      </label>
      <ProjectPicker kind="card" id={card.id} project={card.project ?? null} label />
      {#if assigneeId}<Face person={ui.members.find((m) => m.id === assigneeId) ?? null} size={24} />{/if}
    </div>
    <textarea bind:value={body} placeholder="Details, links, acceptance criteria…" rows="10"></textarea>
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 60;
  }
  .sheet {
    width: 620px;
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 20px 24px 24px;
    background: var(--panel);
    border: 1px solid var(--line-strong);
    border-radius: 12px;
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.6);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .ref {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
  }
  .grow {
    flex: 1;
  }
  .icon {
    background: none;
    border: 0;
    color: var(--muted);
    cursor: pointer;
    display: flex;
    padding: 3px;
    border-radius: 4px;
  }
  .icon:hover {
    color: var(--ink);
    background: var(--accent-soft);
  }
  .title {
    font: inherit;
    font-size: 21px;
    font-weight: 600;
    letter-spacing: -0.02em;
    background: none;
    border: 0;
    color: var(--ink);
    outline: none;
  }
  .row {
    display: flex;
    align-items: flex-end;
    gap: 12px;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 11px;
    color: var(--muted);
  }
  select,
  textarea {
    font: inherit;
    font-size: 13px;
    color: var(--ink);
    background: var(--bg);
    border: 1px solid var(--line-strong);
    border-radius: var(--r-md);
    padding: 6px 8px;
  }
  textarea {
    resize: vertical;
    line-height: 1.55;
    min-height: 160px;
  }
</style>
