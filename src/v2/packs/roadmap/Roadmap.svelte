<script lang="ts">
  // The roadmap: a plan drawn as the order it can happen in. See model.ts for
  // why there is no calendar. It is a surface like the Canvas tab's, the whole
  // page and free to pan and zoom, with steps that look like the board's cards
  // and open the way a card opens.
  import { SvelteFlow, Background, BackgroundVariant, MarkerType, type Node, type Edge, type Connection } from '@xyflow/svelte'
  import '@xyflow/svelte/dist/style.css'
  import Plus from '@lucide/svelte/icons/plus'
  import Minus from '@lucide/svelte/icons/minus'
  import X from '@lucide/svelte/icons/x'
  import Trash2 from '@lucide/svelte/icons/trash-2'
  import Maximize2 from '@lucide/svelte/icons/maximize-2'
  import Minimize2 from '@lucide/svelte/icons/minimize-2'
  import CircleHelp from '@lucide/svelte/icons/circle-help'
  import Eye from '@lucide/svelte/icons/eye'
  import Header from '../../Header.svelte'
  import Face from '../../Face.svelte'
  import Select from '../../Select.svelte'
  import FlowApi from '../../canvas/FlowApi.svelte'
  import StepNode from './StepNode.svelte'
  import DecisionNode from './DecisionNode.svelte'
  import { v2, type Person } from '../../api'
  import { untrack } from 'svelte'
  import { ui } from '../../state.svelte'
  import { canEditHere, scope } from '../../project.svelte'
  import { peek, load as fetchCached, put } from '../../cache'
  import { EMPTY, layout, newId, standing, summary, tidy, wouldLoop, type Decision, type Roadmap, type Step } from './model'

  let { tabName }: { kind: string; tabName: string; view: string } = $props()

  // One roadmap per project, and one for the workspace as a whole (what shows
  // with every project in view, or with projects off). Each is its own pack
  // data, so an agent reads a project's with get_pack_data key:"roadmap.<id>".
  const PATH = $derived(scope.enabled && scope.id && scope.id !== 'none' ? `/packs/roadmap.${scope.id}` : '/packs/roadmap.main')
  let road = $state<Roadmap>(tidy(peek(PATH) ?? EMPTY))
  let loading = $state(!peek(PATH))
  let saving = $state(false)
  let open = $state<{ kind: 'step' | 'decision'; id: string } | null>(null)
  let showSettled = $state(false)
  let filled = $state(false)
  let zoom = $state(1)
  let flow: any = null
  const canEdit = $derived(canEditHere())

  // Whichever project is in view, that project's roadmap.
  $effect(() => {
    const path = PATH
    untrack(() => {
      clearTimeout(timer)
      open = null
      road = tidy(peek(path) ?? EMPTY)
      loading = !peek(path)
    })
    fetchCached<unknown>(path)
      .then((raw) => {
        if (path === PATH) road = tidy(raw)
      })
      // A project with no roadmap yet says so with a 404: that is an empty one.
      .catch(() => {})
      .finally(() => {
        if (path === PATH) ((loading = false), setTimeout(fit, 80))
      })
  })

  let timer: ReturnType<typeof setTimeout> | undefined
  function changed(next: Roadmap) {
    road = tidy(next)
    put(PATH, $state.snapshot(road))
    saving = true
    clearTimeout(timer)
    timer = setTimeout(async () => {
      try {
        await v2.put(PATH, $state.snapshot(road))
      } catch (e) {
        ui.error = (e as Error).message
      }
      saving = false
    }, 500)
  }

  // --- people: somebody in the workspace, or a name ------------------------------
  const who = (owner: string): Person => ui.members.find((m) => m.id === owner) ?? { id: owner, name: owner, email: null, avatar: null, role: 'guest' }
  const nameOf = (owner: string) => who(owner).name.split(' ')[0]
  const dueLabel = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

  // --- the map ---------------------------------------------------------------------
  const nodeTypes = { step: StepNode, decision: DecisionNode }
  const sum = $derived(summary(road))
  const stepOf = (id: string) => road.steps.find((s) => s.id === id)
  const NEXT: Record<Step['state'], Step['state']> = { todo: 'doing', doing: 'done', done: 'todo' }
  const cycle = (id: string) => setStep(id, { state: NEXT[stepOf(id)?.state ?? 'todo'] })

  let nodes = $state.raw<Node[]>([])
  let edges = $state.raw<Edge[]>([])
  $effect(() => {
    const placed = layout(road, showSettled)
    const editable = canEdit
    nodes = [
      ...placed.steps.map(({ step, x, y, n }) => ({
        id: step.id,
        type: 'step',
        position: { x, y },
        draggable: false,
        data: { step, n, at: standing(road, step), owners: step.owners.map(who), due: step.due ? dueLabel(step.due) : null, canEdit: editable, oncycle: cycle },
      })),
      ...placed.decisions.map(({ decision, x, y }) => ({
        id: decision.id,
        type: 'decision',
        position: { x, y },
        draggable: false,
        data: { decision, owner: decision.owner ? who(decision.owner) : null },
      })),
    ]
    const shown = new Set(placed.decisions.map((p) => p.decision.id))
    edges = [
      ...road.steps.flatMap((step) =>
        step.after.map((before) => {
          const done = stepOf(before)?.state === 'done'
          return {
            id: `${before}>${step.id}`,
            source: before,
            target: step.id,
            deletable: editable,
            style: `stroke:${done ? 'var(--line)' : 'var(--muted)'};stroke-width:1.5px`,
            markerEnd: { type: MarkerType.ArrowClosed, color: done ? 'var(--line)' : 'var(--muted)', width: 16, height: 16 },
          } as Edge
        }),
      ),
      // A decision points at everything it holds; the first of them is right under it.
      ...road.decisions
        .filter((d) => shown.has(d.id))
        .flatMap((d) =>
          d.blocks.map(
            (held) =>
              ({
                id: `${d.id}?${held}`,
                source: d.id,
                sourceHandle: 'down',
                target: held,
                targetHandle: 'top',
                deletable: editable,
                style: 'stroke:var(--muted);stroke-width:1.5px;stroke-dasharray:3 4',
              }) as Edge,
          ),
        ),
    ]
  })

  const fit = () => flow?.fitView({ padding: 0.16, duration: 350, maxZoom: 1 })

  function onconnect(c: Connection) {
    if (!canEdit || !c.source || !c.target) return
    const decision = road.decisions.find((d) => d.id === c.source)
    if (decision) return void (stepOf(c.target) && !decision.blocks.includes(c.target) && setDecision(decision.id, { blocks: [...decision.blocks, c.target] }))
    const step = stepOf(c.target)
    if (!step || !stepOf(c.source) || step.after.includes(c.source)) return
    if (wouldLoop(road, step.id, c.source)) return void (ui.error = `${stepOf(c.source)?.title} already waits on ${step.title}, so it cannot also come first.`)
    setStep(step.id, { after: [...step.after, c.source] })
  }
  function ondelete({ edges: gone }: { nodes: Node[]; edges: Edge[] }) {
    let next = $state.snapshot(road) as Roadmap
    for (const e of gone) {
      if (e.id.includes('>')) next = { ...next, steps: next.steps.map((s) => (s.id === e.target ? { ...s, after: s.after.filter((a) => a !== e.source) } : s)) }
      else next = { ...next, decisions: next.decisions.map((d) => (d.id === e.source ? { ...d, blocks: d.blocks.filter((b) => b !== e.target) } : d)) }
    }
    if (gone.length) changed(next)
  }

  // --- editing ---------------------------------------------------------------------
  const setStep = (id: string, patch: Partial<Step>) => changed({ ...road, steps: road.steps.map((s) => (s.id === id ? { ...s, ...patch } : s)) })
  const setDecision = (id: string, patch: Partial<Decision>) => changed({ ...road, decisions: road.decisions.map((d) => (d.id === id ? { ...d, ...patch } : d)) })
  const toggle = <T,>(list: T[], item: T) => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item])

  function addStep() {
    const last = layout(road).steps.at(-1)?.step
    const step: Step = { id: newId('step'), title: 'New step', owners: [], after: last ? [last.id] : [], state: 'todo' }
    changed({ ...road, steps: [...road.steps, step] })
    open = { kind: 'step', id: step.id }
    setTimeout(fit, 120)
  }
  function addDecision(blocks: string[] = []) {
    const d: Decision = { id: newId('decision'), question: 'What has to be decided?', owner: ui.me?.id, blocks }
    changed({ ...road, decisions: [...road.decisions, d] })
    open = { kind: 'decision', id: d.id }
  }
  function removeStep(id: string) {
    if (!confirm(`Delete “${stepOf(id)?.title}”? Steps that waited on it stop waiting.`)) return
    open = null
    changed({ steps: road.steps.filter((s) => s.id !== id), decisions: road.decisions })
  }
  function removeDecision(id: string) {
    open = null
    changed({ ...road, decisions: road.decisions.filter((d) => d.id !== id) })
  }
  let ownerName = $state('')
  function addOwnerByName(step: Step) {
    const name = ownerName.trim()
    ownerName = ''
    if (name && !step.owners.includes(name)) setStep(step.id, { owners: [...step.owners, name] })
  }
  /** Take the text out of a field as it is left, not on every key. */
  const onleave = (fn: (v: string) => void) => (e: Event) => fn((e.currentTarget as HTMLInputElement | HTMLTextAreaElement).value)

  const openStep = $derived(open?.kind === 'step' ? (stepOf(open.id) ?? null) : null)
  const openDecision = $derived(open?.kind === 'decision' ? (road.decisions.find((d) => d.id === open!.id) ?? null) : null)
  const settledCount = $derived(road.decisions.filter((d) => d.answer).length)

  function onkey(e: KeyboardEvent) {
    if (e.key !== 'Escape') return
    if (open) open = null
    else if (filled) filled = false
  }
</script>

<svelte:window onkeydown={onkey} />

<div class="page" class:filled>
  <Header crumbs={[tabName]}>
    <span class="state">{saving ? 'Saving…' : ''}</span>
    {#if canEdit}
      <button class="ghost" onclick={() => addDecision()}><CircleHelp size={12} /><span>New decision</span></button>
      <button class="primary" onclick={addStep}><Plus size={12} /><span>New step</span></button>
    {/if}
  </Header>

  <div class="flowhost">
    {#if !loading && !road.steps.length}
      <div class="blank">
        <h2>Nothing planned yet</h2>
        <p>A roadmap here is an order, not a calendar: steps, what each one waits on, who owns it, and the decisions in the way. Dates are welcome and never required.</p>
        {#if canEdit}<button class="primary" onclick={addStep}><Plus size={12} /><span>Add the first step</span></button>{/if}
      </div>
    {:else}
      <SvelteFlow
        bind:nodes
        bind:edges
        {nodeTypes}
        colorMode="dark"
        minZoom={0.2}
        maxZoom={1.5}
        nodesDraggable={false}
        nodesConnectable={canEdit}
        elementsSelectable
        panOnScroll
        zoomOnScroll={false}
        zoomOnPinch
        zoomOnDoubleClick={false}
        deleteKey={canEdit ? ['Backspace', 'Delete'] : null}
        onmove={(_e, v) => (zoom = v.zoom)}
        {onconnect}
        {ondelete}
        onnodeclick={({ node }) => (open = { kind: node.type === 'decision' ? 'decision' : 'step', id: node.id })}
        proOptions={{ hideAttribution: true }}
      >
        <FlowApi onready={(api) => ((flow = api), setTimeout(fit, 60))} />
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} bgColor="var(--panel)" patternColor="var(--line)" />
      </SvelteFlow>

      <!-- The morning's answer, kept out of the way of the map. -->
      <div class="today">
        <div class="fact">
          <span class="k">Can start</span>
          {#each sum.ready as s (s.id)}
            <button class="chip" onclick={() => (open = { kind: 'step', id: s.id })}><i class="go"></i>{s.title}</button>
          {:else}
            <span class="v">{sum.doing.length ? 'Nothing new' : 'Nothing yet'}</span>
          {/each}
        </div>
        {#if sum.doing.length}
          <div class="fact"><span class="k">Under way</span>{#each sum.doing as s (s.id)}<button class="chip" onclick={() => (open = { kind: 'step', id: s.id })}>{s.title}</button>{/each}</div>
        {/if}
        {#if sum.openDecisions.length}
          <div class="fact">
            <span class="k">Waiting on</span>
            <span class="v">{sum.openDecisions.length} decision{sum.openDecisions.length === 1 ? '' : 's'}</span>
            {#each sum.deciders as [owner, count] (owner)}<span class="decider"><Face person={who(owner)} size={16} />{nameOf(owner)}{sum.deciders.length > 1 ? ` · ${count}` : ''}</span>{/each}
          </div>
        {/if}
      </div>

      <div class="tools">
        <button class="tool" title="Zoom out" onclick={() => flow?.zoomOut({ duration: 160 })}><Minus size={16} /></button>
        <button class="tool zoom" title="Fit the roadmap" onclick={fit}>{Math.round(zoom * 100)}%</button>
        <button class="tool" title="Zoom in" onclick={() => flow?.zoomIn({ duration: 160 })}><Plus size={16} /></button>
        <span class="div"></span>
        {#if settledCount}
          <button class="tool" class:on={showSettled} title={showSettled ? 'Hide settled decisions' : `Show ${settledCount} settled decision${settledCount === 1 ? '' : 's'}`} onclick={() => ((showSettled = !showSettled), setTimeout(fit, 80))}><Eye size={16} /></button>
        {/if}
        <button class="tool" class:on={filled} title={filled ? 'Back to the app (Esc)' : 'Fill the window'} onclick={() => ((filled = !filled), setTimeout(fit, 80))}>
          {#if filled}<Minimize2 size={15} />{:else}<Maximize2 size={15} />{/if}
        </button>
      </div>
    {/if}
  </div>
</div>

{#if openStep}
  {@const s = openStep}
  {@const at = standing(road, s)}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="scrim" onclick={() => (open = null)}>
    <div class="sheet" onclick={(e) => e.stopPropagation()}>
      <div class="head">
        <span class="ref">STEP {layout(road, showSettled).steps.find((p) => p.step.id === s.id)?.n ?? ''}</span>
        <span class="stand"><i class={at.kind}></i>{at.kind === 'ready' ? 'Ready to start' : at.kind === 'doing' ? 'Under way' : at.kind === 'done' ? 'Done' : at.kind === 'decision' ? 'Needs a decision' : 'Waiting on a step'}</span>
        <span class="grow"></span>
        {#if canEdit}<button class="icon" title="Delete step" onclick={() => removeStep(s.id)}><Trash2 size={14} /></button>{/if}
        <button class="icon" title="Close" onclick={() => (open = null)}><X size={15} /></button>
      </div>
      {#key s.id}
        <input class="title" disabled={!canEdit} value={s.title} onblur={onleave((v) => v.trim() && v !== s.title && setStep(s.id, { title: v.trim() }))} onkeydown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
      {/key}
      <div class="row">
        <label>
          <span>Progress</span>
          <Select value={s.state} disabled={!canEdit} options={[{ value: 'todo', label: 'Not started' }, { value: 'doing', label: 'Under way' }, { value: 'done', label: 'Done' }]} onchange={(v) => setStep(s.id, { state: v as Step['state'] })} ariaLabel="Progress" />
        </label>
        <label>
          <span>Date, if it has one</span>
          <input class="field" type="date" disabled={!canEdit} value={s.due ?? ''} onchange={(e) => setStep(s.id, { due: e.currentTarget.value || undefined })} />
        </label>
      </div>

      <div class="group">
        <span class="lab">Who</span>
        <div class="people">
          {#each ui.members as m (m.id)}
            <button class="person" class:on={s.owners.includes(m.id)} disabled={!canEdit} onclick={() => setStep(s.id, { owners: toggle(s.owners, m.id) })}><Face person={m} size={18} />{m.name.split(' ')[0]}</button>
          {/each}
          {#each s.owners.filter((o) => !ui.members.some((m) => m.id === o)) as o (o)}
            <button class="person on" disabled={!canEdit} title="Not in this workspace yet. Click to take off." onclick={() => setStep(s.id, { owners: s.owners.filter((x) => x !== o) })}><Face person={who(o)} size={18} />{o}</button>
          {/each}
          {#if canEdit}<input class="name" placeholder="Someone else, Enter" bind:value={ownerName} onkeydown={(e) => e.key === 'Enter' && addOwnerByName(s)} />{/if}
        </div>
        {#if s.owners.length > 1}
          <label class="check"><input type="checkbox" disabled={!canEdit} checked={!!s.undecided} onchange={(e) => setStep(s.id, { undecided: e.currentTarget.checked })} />One of them, not settled which</label>
        {/if}
      </div>

      <div class="cols">
        <div class="group">
          <span class="lab">Cannot start before</span>
          {#each road.steps.filter((x) => x.id !== s.id) as other (other.id)}
            {@const loops = !s.after.includes(other.id) && wouldLoop(road, s.id, other.id)}
            <label class="check" class:off={loops} title={loops ? `${other.title} already waits on this step` : ''}>
              <input type="checkbox" disabled={!canEdit || loops} checked={s.after.includes(other.id)} onchange={() => setStep(s.id, { after: toggle(s.after, other.id) })} />{other.title}
            </label>
          {:else}
            <span class="none">This is the only step so far.</span>
          {/each}
        </div>
        <div class="group">
          <span class="lab">Decisions in the way</span>
          {#each road.decisions.filter((d) => d.blocks.includes(s.id)) as d (d.id)}
            <button class="link" onclick={() => (open = { kind: 'decision', id: d.id })}><span class="mk">{d.answer ? '✓' : '?'}</span>{d.question}</button>
          {:else}
            <span class="none">None.</span>
          {/each}
          {#if canEdit}<button class="add" onclick={() => addDecision([s.id])}><Plus size={11} />A decision holds this up</button>{/if}
        </div>
      </div>

      {#key s.id}
        <textarea disabled={!canEdit} rows="5" placeholder="What this step is, links, what done looks like…" value={s.note ?? ''} onblur={onleave((v) => v !== (s.note ?? '') && setStep(s.id, { note: v }))}></textarea>
      {/key}
    </div>
  </div>
{:else if openDecision}
  {@const d = openDecision}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="scrim" onclick={() => (open = null)}>
    <div class="sheet" onclick={(e) => e.stopPropagation()}>
      <div class="head">
        <span class="ref">DECISION</span>
        <span class="stand"><i class={d.answer ? 'done' : 'decision'}></i>{d.answer ? 'Settled' : 'Open'}</span>
        <span class="grow"></span>
        {#if canEdit}<button class="icon" title="Delete decision" onclick={() => removeDecision(d.id)}><Trash2 size={14} /></button>{/if}
        <button class="icon" title="Close" onclick={() => (open = null)}><X size={15} /></button>
      </div>
      {#key d.id}
        <input class="title" disabled={!canEdit} value={d.question} onblur={onleave((v) => v.trim() && v !== d.question && setDecision(d.id, { question: v.trim() }))} onkeydown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
      {/key}
      <div class="row">
        <label>
          <span>Who decides</span>
          <Select
            value={d.owner ?? ''}
            disabled={!canEdit}
            options={[{ value: '', label: 'Nobody yet' }, ...ui.members.map((m) => ({ value: m.id, label: m.name })), ...(d.owner && !ui.members.some((m) => m.id === d.owner) ? [{ value: d.owner, label: d.owner }] : [])]}
            onchange={(v) => setDecision(d.id, { owner: v || undefined })}
            ariaLabel="Who decides"
          />
        </label>
      </div>
      <div class="group">
        <span class="lab">Holds up</span>
        {#each road.steps as s (s.id)}
          <label class="check"><input type="checkbox" disabled={!canEdit} checked={d.blocks.includes(s.id)} onchange={() => setDecision(d.id, { blocks: toggle(d.blocks, s.id) })} />{s.title}</label>
        {/each}
      </div>
      <span class="lab">What was decided</span>
      {#key d.id}
        <textarea disabled={!canEdit} rows="4" placeholder="Write the answer, and the steps it held are free to start" value={d.answer ?? ''} onblur={onleave((v) => v !== (d.answer ?? '') && setDecision(d.id, { answer: v.trim() || undefined }))}></textarea>
      {/key}
    </div>
  </div>
{/if}

<style>
  .page {
    height: 100%;
    display: flex;
    flex-direction: column;
    min-width: 0;
    background: var(--bg);
  }
  /* Over the sidebar and everything else: the map and nothing but the map. */
  .page.filled {
    position: fixed;
    inset: 0;
    z-index: 50;
  }
  .flowhost {
    flex: 1;
    position: relative;
    min-height: 0;
  }
  .flowhost :global(.svelte-flow) {
    --xy-selection-background-color: var(--accent-soft);
    --xy-selection-border: 1px solid var(--line-strong);
  }
  .flowhost :global(.svelte-flow__node) {
    background: none;
    border: 0;
    padding: 0;
    box-shadow: none;
    border-radius: var(--r-lg);
  }
  .flowhost :global(.svelte-flow__node.selected) {
    outline: 1px solid var(--muted);
  }
  .flowhost :global(.svelte-flow__handle) {
    width: 8px;
    height: 8px;
    background: var(--panel);
    border: 1.5px solid var(--muted);
    opacity: 0;
  }
  .flowhost :global(.svelte-flow__handle.quiet) {
    opacity: 0 !important;
    pointer-events: none;
  }
  .flowhost :global(.svelte-flow__node:hover .svelte-flow__handle) {
    opacity: 1;
  }
  .flowhost :global(.svelte-flow__edge.selected .svelte-flow__edge-path) {
    stroke: var(--ink) !important;
  }
  .state {
    font-size: 12px;
    color: var(--muted);
  }
  button {
    font: inherit;
    color: inherit;
    cursor: pointer;
  }
  .primary,
  .ghost {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 10px;
    border-radius: var(--r-md);
    font-size: 12px;
  }
  .primary {
    background: var(--ink);
    color: var(--on-accent);
    border: 0;
    font-weight: 600;
  }
  .ghost {
    border: 1px solid var(--line-strong);
    background: var(--raised);
    color: var(--ink);
  }
  .blank {
    max-width: 460px;
    margin: 14vh auto 0;
    padding: 0 24px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    align-items: flex-start;
  }
  .blank h2 {
    margin: 0;
    font-size: var(--fs-5);
    font-weight: 600;
    letter-spacing: -0.02em;
  }
  .blank p {
    margin: 0 0 6px;
    font-size: 13px;
    line-height: 1.6;
    color: var(--muted);
  }

  .today {
    position: absolute;
    left: 16px;
    top: 16px;
    z-index: 5;
    max-width: min(560px, calc(100% - 32px));
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 12px;
    border-radius: var(--r-lg);
    background: var(--raised);
    border: 1px solid var(--line-strong);
    box-shadow: var(--shadow-md);
  }
  .fact {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    min-height: 22px;
    font-size: 12px;
  }
  .k {
    width: 76px;
    flex: none;
    font-size: 11px;
    color: var(--muted);
  }
  .v {
    color: var(--ink-2);
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 22px;
    padding: 0 8px;
    border-radius: var(--r-pill);
    border: 1px solid var(--line-strong);
    background: var(--bg);
    font-size: 12px;
    color: var(--ink);
  }
  .chip:hover {
    border-color: var(--muted);
  }
  .go {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--running);
  }
  .decider {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--ink-2);
  }

  .tools {
    position: absolute;
    left: 50%;
    bottom: 20px;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 5px;
    border-radius: 12px;
    background: var(--raised);
    border: 1px solid var(--line-strong);
    box-shadow: var(--shadow-md);
    z-index: 5;
  }
  .tool {
    width: 36px;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: 8px;
    background: none;
    color: var(--ink-2);
  }
  .tool:hover,
  .tool.on {
    color: var(--ink);
    background: var(--accent-soft);
  }
  .tool.zoom {
    width: auto;
    min-width: 50px;
    padding: 0 6px;
    font-family: var(--mono);
    font-size: 11px;
  }
  .div {
    width: 1px;
    height: 20px;
    background: var(--line-strong);
    margin: 0 2px;
  }

  /* Opened the way a card on the board opens. */
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
  }
  .grow {
    flex: 1;
  }
  .ref {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
  }
  .stand {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--ink-2);
  }
  .stand i {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--line-strong);
  }
  .stand i.ready {
    background: var(--running);
  }
  .stand i.doing,
  .stand i.done {
    background: var(--ink-2);
  }
  .stand i.decision {
    background: none;
    border: 1px dashed var(--muted);
    box-sizing: border-box;
  }
  .icon {
    display: flex;
    padding: 4px;
    border: 0;
    border-radius: var(--r-sm);
    background: none;
    color: var(--muted);
  }
  .icon:hover {
    color: var(--ink);
    background: var(--accent-soft);
  }
  .title {
    font: inherit;
    font-size: var(--fs-6);
    font-weight: 600;
    letter-spacing: -0.02em;
    background: none;
    border: 0;
    color: var(--ink);
    outline: none;
    padding: 0;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 12px;
  }
  .row label,
  .group {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: var(--fs-1);
    color: var(--muted);
    min-width: 0;
  }
  .cols {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 20px;
  }
  .lab {
    font-size: var(--fs-1);
    color: var(--muted);
  }
  .field,
  textarea,
  .name {
    font: inherit;
    font-size: 13px;
    color: var(--ink);
    background: var(--raised);
    border: 1px solid var(--line-strong);
    border-radius: var(--r-md);
    outline: none;
    box-sizing: border-box;
    color-scheme: dark light;
  }
  .field {
    height: 30px;
    padding: 0 8px;
  }
  textarea {
    width: 100%;
    padding: 10px 12px;
    line-height: 1.55;
    resize: vertical;
  }
  .field:focus,
  textarea:focus,
  .name:focus {
    border-color: var(--muted);
  }
  .people {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .person {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 26px;
    padding: 0 9px 0 4px;
    border-radius: var(--r-pill);
    border: 1px solid var(--line-strong);
    background: none;
    font-size: 12px;
    color: var(--muted);
  }
  .person.on {
    background: var(--raised);
    color: var(--ink);
    border-color: var(--muted);
  }
  .name {
    height: 26px;
    width: 170px;
    padding: 0 9px;
    border-radius: var(--r-pill);
    font-size: 12px;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    color: var(--ink-2);
    cursor: pointer;
  }
  .check.off {
    opacity: 0.45;
    cursor: default;
  }
  .check input {
    accent-color: var(--ink);
    margin: 0;
  }
  .link {
    display: flex;
    gap: 8px;
    background: none;
    border: 0;
    padding: 0;
    text-align: left;
    font-size: 13px;
    color: var(--ink-2);
  }
  .link:hover {
    color: var(--ink);
  }
  .mk {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
    line-height: 19px;
  }
  .add {
    align-self: flex-start;
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 0;
    border: 0;
    background: none;
    font-size: 12px;
    color: var(--muted);
  }
  .add:hover {
    color: var(--ink);
  }
  .none {
    font-size: 13px;
    color: var(--muted);
  }
</style>
