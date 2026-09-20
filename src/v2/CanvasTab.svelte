<script lang="ts">
  // Canvas: whiteboards. Frames that hug their content, outlined objects,
  // right-angle arrows, tools along the bottom. Same JSON as React Flow, so a
  // board made elsewhere in that format opens here unchanged.
  import { scope, canEditHere } from './project.svelte'
  import ProjectChip from './ProjectChip.svelte'
  import ProjectPicker from './ProjectPicker.svelte'
  import { SvelteFlow, Background, BackgroundVariant, type Node, type Edge, type Connection } from '@xyflow/svelte'
  import '@xyflow/svelte/dist/style.css'
  import Plus from '@lucide/svelte/icons/plus'
  import MousePointer2 from '@lucide/svelte/icons/mouse-pointer-2'
  import Hand from '@lucide/svelte/icons/hand'
  import Frame from '@lucide/svelte/icons/frame'
  import StickyNote from '@lucide/svelte/icons/sticky-note'
  import Square from '@lucide/svelte/icons/square'
  import Type from '@lucide/svelte/icons/type'
  import Trash2 from '@lucide/svelte/icons/trash-2'
  import Undo2 from '@lucide/svelte/icons/undo-2'
  import Redo2 from '@lucide/svelte/icons/redo-2'
  import Shapes from '@lucide/svelte/icons/shapes'
  import Minus from '@lucide/svelte/icons/minus'
  import Header from './Header.svelte'
  import CopyNode from './CopyNode.svelte'
  import CardNode from './canvas/CardNode.svelte'
  import SectionNode from './canvas/SectionNode.svelte'
  import ImageNode from './canvas/ImageNode.svelte'
  import FlowApi from './canvas/FlowApi.svelte'
  import Layers from '@lucide/svelte/icons/layers'
  import { PALETTE } from './canvas/tone'
  import { v2, ago, type Canvas, type CanvasSummary } from './api'
  import { ui, go } from './state.svelte'
  import Skeleton from './Skeleton.svelte'
  import { peek, load as fetchCached, put, prefetch } from './cache'

  let { tabId, tabName = 'Canvas' }: { tabId: string; tabName?: string } = $props()

  const nodeTypes = { card: CardNode, sticky: CardNode, shape: CardNode, text: CardNode, section: SectionNode, image: ImageNode }

  let list = $state<CanvasSummary[]>(peek<CanvasSummary[]>('/canvases') ?? [])
  let loadingList = $state(!peek('/canvases'))
  let canvas = $state<Canvas | null>(null)
  let nodes = $state.raw<Node[]>([])
  let edges = $state.raw<Edge[]>([])
  let saving = $state<'idle' | 'saving' | 'saved' | 'conflict'>('idle')
  /** Which tool has the pointer. Space held down borrows the hand, as everywhere else. */
  let tool = $state<'select' | 'pan'>('select')
  let space = $state(false)
  let zoom = $state(1)
  const grabbing = $derived(tool === 'pan' || space)
  /** The raw node as stored, so fields this editor does not know survive a save. */
  let raw = new Map<string, any>()
  let rawEdges = new Map<string, any>()
  let flow: any = null
  let framesOpen = $state(false)
  let history: string[] = []
  let future: string[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastSaved = ''

  async function loadList() {
    loadingList = true
    try {
      list = await fetchCached<CanvasSummary[]>('/canvases')
    } catch (e) {
      ui.error = (e as Error).message
    }
    loadingList = false
  }
  loadList()

  // --- stored JSON <-> Svelte Flow --------------------------------------------
  const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) || undefined : undefined)

  function toFlow(n: any): Node {
    raw.set(n.id, n)
    const w = num(n.style?.width) ?? n.width
    const h = num(n.style?.height) ?? n.height
    return {
      id: n.id,
      type: nodeTypes[n.type as keyof typeof nodeTypes] ? n.type : 'card',
      position: n.position ?? { x: 0, y: 0 },
      data: n.data ?? {},
      width: w,
      height: h,
      zIndex: n.type === 'section' ? -10 : (n.zIndex ?? 0),
      // A frame is moved by its name, the way frames move in every other tool.
      // Dragging inside one draws a selection instead, which is what the space
      // is for; and the frame carries what is in it (see `follow`).
      ...(n.type === 'section' ? { dragHandle: '.framegrip' } : {}),
      ...(n.parentId ? { parentId: n.parentId } : {}),
    }
  }
  /** A stored edge style ({stroke, strokeWidth, strokeDasharray}) as the CSS Svelte Flow wants. */
  function css(o: Record<string, unknown> | string | undefined) {
    if (!o) return ''
    if (typeof o === 'string') return o
    return Object.entries(o)
      .map(([k, v]) => `${k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())}:${v}`)
      .join(';')
  }
  function edgeToFlow(e: any): Edge {
    rawEdges.set(e.id, e)
    const dashed = e.data?.certainty === 'unverified'
    const base = css(e.style) || 'stroke:#7a848d;stroke-width:2'
    const style = dashed && !/dasharray/.test(base) ? `${base};stroke-dasharray:7 6` : base
    const stroke = /stroke:\s*([^;]+)/.exec(style)?.[1] ?? '#7a848d'
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle ?? undefined,
      targetHandle: e.targetHandle ?? undefined,
      type: e.type === 'straight' || e.type === 'step' || e.type === 'default' ? e.type : 'smoothstep',
      label: e.label || undefined,
      labelStyle: 'fill:#d4d4d4;font-weight:600;font-size:18px',
      data: e.data,
      style,
      markerEnd: e.markerEnd ?? { type: 'arrowclosed' as any, color: stroke },
    }
  }
  function fromFlow(n: Node) {
    const base = raw.get(n.id) ?? { id: n.id, type: n.type }
    const width = n.width ?? n.measured?.width
    const height = n.height ?? n.measured?.height
    return {
      ...base,
      type: n.type,
      position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
      data: n.data,
      style: { ...(base.style ?? {}), ...(width ? { width: Math.round(width) } : {}), ...(height ? { height: Math.round(height) } : {}) },
      ...(n.type === 'section' ? { zIndex: -10 } : {}),
    }
  }
  function edgeFromFlow(e: Edge) {
    const base = rawEdges.get(e.id) ?? { type: 'smoothstep', data: { certainty: 'documented' } }
    return {
      ...base,
      id: e.id,
      source: e.source,
      target: e.target,
      ...(e.sourceHandle ? { sourceHandle: e.sourceHandle } : {}),
      ...(e.targetHandle ? { targetHandle: e.targetHandle } : {}),
      label: typeof e.label === 'string' ? e.label : (base.label ?? ''),
      data: e.data ?? base.data ?? { certainty: 'documented' },
    }
  }

  // --- frames hug what is inside them ---------------------------------------------
  const rect = (n: Node) => ({ x: n.position.x, y: n.position.y, w: n.width ?? n.measured?.width ?? 0, h: n.height ?? n.measured?.height ?? 0 })
  const inside = (a: ReturnType<typeof rect>, b: ReturnType<typeof rect>) =>
    a.x + a.w / 2 > b.x && a.x + a.w / 2 < b.x + b.w && a.y + a.h / 2 > b.y && a.y + a.h / 2 < b.y + b.h

  /** Resize every frame to fit the objects in it, innermost first. */
  function fitFrames(list: Node[]): Node[] {
    const out = list.map((n) => ({ ...n }))
    const frames = out.filter((n) => n.type === 'section').sort((a, b) => rect(a).w * rect(a).h - rect(b).w * rect(b).h)
    for (const f of frames) {
      const fr = rect(f)
      const kids = out.filter((n) => n !== f && inside(rect(n), fr) && !(n.type === 'section' && rect(n).w * rect(n).h >= fr.w * fr.h))
      if (!kids.length) continue
      const minX = Math.min(...kids.map((k) => rect(k).x))
      const minY = Math.min(...kids.map((k) => rect(k).y))
      const maxX = Math.max(...kids.map((k) => rect(k).x + rect(k).w))
      const maxY = Math.max(...kids.map((k) => rect(k).y + rect(k).h))
      const d = f.data as any
      const pad = d.variant === 'miro-page' ? 42 : 36
      const top = d.variant === 'miro-page' && d.body ? 110 : pad
      f.position = { x: Math.round(minX - pad), y: Math.round(minY - top) }
      f.width = Math.round(maxX - minX + pad * 2)
      f.height = Math.round(maxY - minY + top + pad)
    }
    return out
  }

  /**
   * Moving a frame moves what is in it. Miro and Figma both do this and a board
   * is unusable without it: otherwise the frame slides away and leaves its own
   * cards behind. Taken at the start of the drag, because what counts as inside
   * is decided before anything moves.
   */
  let carried: { anchor: string; from: { x: number; y: number }; kids: Map<string, { x: number; y: number }> } | null = null

  function pickUp(target: Node | null, dragging: Node[]) {
    carried = null
    if (!target || target.type !== 'section') return
    const fr = rect(target)
    const moving = new Set(dragging.map((n) => n.id))
    const kids = new Map<string, { x: number; y: number }>()
    for (const n of nodes) {
      if (n.id === target.id || moving.has(n.id)) continue
      const r = rect(n)
      // A frame inside a frame travels too; a bigger frame around it does not.
      if (!inside(r, fr)) continue
      if (n.type === 'section' && r.w * r.h >= fr.w * fr.h) continue
      kids.set(n.id, { x: n.position.x, y: n.position.y })
    }
    if (kids.size) carried = { anchor: target.id, from: { x: target.position.x, y: target.position.y }, kids }
  }

  function follow(target: Node | null) {
    if (!carried || !target || target.id !== carried.anchor) return
    const dx = target.position.x - carried.from.x
    const dy = target.position.y - carried.from.y
    if (!dx && !dy) return
    nodes = nodes.map((n) => {
      const start = carried!.kids.get(n.id)
      return start ? { ...n, position: { x: start.x + dx, y: start.y + dy } } : n
    })
  }

  const frames = $derived(nodes.filter((n) => n.type === 'section').map((n) => ({ id: n.id, title: (n.data as any).title ?? 'Frame' })))
  function focus(id: string, duration = 450) {
    const n = nodes.find((x) => x.id === id)
    if (!n || !flow) return
    const r = rect(n)
    flow.fitBounds({ x: r.x, y: r.y - 80, width: r.w, height: r.h + 80 }, { padding: 0.08, duration })
    framesOpen = false
  }
  /** Open where the board begins: its first page, as the board was laid out. */
  function opening() {
    if (!flow) return
    const lead = nodes.find((n) => n.id === 'miro-lead-page') ?? null
    if (lead) focus(lead.id, 0)
    else flow.fitView({ padding: 0.15, duration: 0 })
  }

  const snapshot = () => JSON.stringify({ n: nodes.map(fromFlow), e: edges.map(edgeFromFlow) })

  $effect(() => {
    const id = ui.item
    if (!id) {
      canvas = null
      return
    }
    saving = 'idle'
    const cached = peek<Canvas>(`/canvases/${id}`)
    ;(cached ? Promise.resolve(cached) : fetchCached<Canvas>(`/canvases/${id}`))
      .then((c) => {
        raw = new Map()
        rawEdges = new Map()
        history = []
        future = []
        canvas = c
        nodes = fitFrames(c.nodes.map(toFlow))
        edges = c.edges.map(edgeToFlow)
        lastSaved = snapshot()
        setTimeout(opening, 60)
      })
      .catch((e) => (ui.error = (e as Error).message))
  })

  // Any change to the graph (drag, resize, connect, delete) schedules a check;
  // the check compares against what was last saved, so selection alone never saves.
  let watch: ReturnType<typeof setTimeout> | undefined
  $effect(() => {
    nodes
    edges
    clearTimeout(watch)
    watch = setTimeout(changed, 400)
  })

  // --- saving ----------------------------------------------------------------
  function changed() {
    if (!canvas) return
    const now = snapshot()
    if (now === lastSaved) return
    saving = 'saving'
    clearTimeout(timer)
    timer = setTimeout(save, 900)
  }
  function remember() {
    history.push(snapshot())
    if (history.length > 60) history.shift()
    future = []
  }
  async function save() {
    if (!canvas) return
    const snap = snapshot()
    const { n, e } = JSON.parse(snap)
    try {
      const next = await v2.put<Canvas>(`/canvases/${canvas.id}`, { ...canvas, nodes: n, edges: e })
      canvas = { ...canvas, revision: next.revision }
      put(`/canvases/${canvas.id}`, { ...canvas, nodes: n, edges: e })
      lastSaved = snap
      saving = 'saved'
    } catch (err) {
      const m = (err as Error).message
      saving = /changed|reload/i.test(m) ? 'conflict' : 'idle'
      ui.error = m
    }
  }
  function restore(s: string) {
    const { n, e } = JSON.parse(s)
    nodes = n.map(toFlow)
    edges = e.map(edgeToFlow)
    changed()
  }
  function undo() {
    const s = history.pop()
    if (!s) return
    future.push(snapshot())
    restore(s)
  }
  function redo() {
    const s = future.pop()
    if (!s) return
    history.push(snapshot())
    restore(s)
  }

  // --- editing -----------------------------------------------------------------
  const selected = $derived(nodes.filter((n) => n.selected))
  const one = $derived(selected.length === 1 ? selected[0] : null)

  function center() {
    const el = document.querySelector('.svelte-flow__viewport') as HTMLElement | null
    const m = el ? /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([\d.]+)\)/.exec(el.style.transform) : null
    const box = document.querySelector('.flowhost')?.getBoundingClientRect()
    if (!m || !box) return { x: 0, y: 0 }
    const [, tx, ty, s] = m.map(Number)
    return { x: (box.width / 2 - tx) / s, y: (box.height / 2 - ty) / s }
  }

  function add(type: 'sticky' | 'shape' | 'text' | 'section') {
    remember()
    const c = center()
    const size = type === 'section' ? { w: 520, h: 360 } : type === 'text' ? { w: 220, h: 50 } : { w: 170, h: 110 }
    const id = `${type}-${crypto.randomUUID().slice(0, 8)}`
    const data = type === 'section' ? { title: 'New frame', kind: 'section' } : type === 'text' ? { title: 'Text', kind: 'text' } : { title: type === 'sticky' ? 'New note' : 'Shape', kind: type, color: PALETTE[0] }
    nodes = [...nodes.map((n) => ({ ...n, selected: false })), { id, type, position: { x: c.x - size.w / 2, y: c.y - size.h / 2 }, width: size.w, height: size.h, data, selected: true, zIndex: type === 'section' ? -10 : 0 }]
    changed()
  }
  function patchData(id: string, patch: Record<string, unknown>) {
    nodes = nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n))
    changed()
  }
  function recolor(color: string) {
    remember()
    const ids = new Set(selected.map((n) => n.id))
    nodes = nodes.map((n) => (ids.has(n.id) ? { ...n, data: { ...n.data, color } } : n))
    changed()
  }
  function removeSelected() {
    remember()
    const ids = new Set(selected.map((n) => n.id))
    nodes = nodes.filter((n) => !ids.has(n.id))
    edges = edges.filter((e) => !ids.has(e.source) && !ids.has(e.target) && !e.selected)
    changed()
  }
  function onconnect(c: Connection) {
    remember()
    edges = [...edges, edgeToFlow({ id: `edge-${crypto.randomUUID().slice(0, 8)}`, source: c.source, target: c.target, sourceHandle: c.sourceHandle, targetHandle: c.targetHandle, data: { certainty: 'documented' } })]
    changed()
  }

  async function removeCanvas() {
    if (!canvas || !confirm(`Delete “${canvas.title}”?`)) return
    const id = canvas.id
    const before = list
    list = list.filter((c) => c.id !== id)
    put('/canvases', list)
    go(tabId)
    try {
      await v2.del(`/canvases/${id}`)
    } catch (e) {
      list = before
      put('/canvases', before)
      ui.error = (e as Error).message
    }
  }

  async function create() {
    try {
      const c = await v2.post<Canvas>('/canvases', { title: 'Untitled canvas' })
      list = [{ id: c.id, title: c.title, updatedAt: new Date().toISOString(), nodeCount: 0, thumb: null }, ...list]
      go(tabId, c.id)
    } catch (e) {
      ui.error = (e as Error).message
    }
  }

  const md = () => {
    if (!one) return ''
    const d = one.data as any
    return `${d.title ?? ''}${d.body ? `\n\n${d.body}` : ''}`
  }
</script>

<svelte:window
  onkeydown={(e) => {
    if (!canvas || (e.target as HTMLElement)?.closest('input,textarea,[contenteditable]')) return
    if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
      e.preventDefault()
      e.shiftKey ? redo() : undo()
      return
    }
    if ((e.metaKey || e.ctrlKey) && (e.key === '0' || e.key === '1')) {
      e.preventDefault()
      flow?.fitView({ padding: 0.12, duration: 450 })
      return
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return
    // The tools, on the keys every canvas uses for them.
    if (e.code === 'Space' && !space) {
      e.preventDefault()
      space = true
      return
    }
    const key = e.key.toLowerCase()
    if (key === 'v') tool = 'select'
    else if (key === 'h') tool = 'pan'
    else if (key === 'f') add('section')
    else if (key === 'n') add('sticky')
    else if (key === 'r') add('shape')
    else if (key === 't') add('text')
  }}
  onkeyup={(e) => {
    if (e.code === 'Space') space = false
  }}
  onblur={() => (space = false)}
/>

{#if ui.item && !canvas}
  <div class="page">
    <Header crumbs={[{ label: tabName, onclick: () => go(tabId) }, list.find((c) => c.id === ui.item)?.title ?? '']} />
    <div class="flowhost loading"><Skeleton w={180} h={12} /></div>
  </div>
{:else if canvas}
  <div class="page">
    <Header crumbs={[{ label: tabName, onclick: () => go(tabId) }, canvas.title]}>
      {#if frames.length}
        <div class="frames">
          <button class="fbtn" onclick={() => (framesOpen = !framesOpen)}><Layers size={13} /><span>Frames</span><b>{frames.length}</b></button>
          {#if framesOpen}
            <div class="fmenu">
              {#each frames as f (f.id)}<button onclick={() => focus(f.id)}>{f.title}</button>{/each}
            </div>
          {/if}
        </div>
      {/if}
      {#if canvas}<ProjectPicker kind="canvas" id={canvas.id} project={canvas.project ?? null} onchange={(p) => (list = list.map((x) => (x.id === canvas?.id ? { ...x, project: p } : x)))} />{/if}
      <button class="icon" title="Fit board" onclick={() => flow?.fitView({ padding: 0.12, duration: 450 })}><Shapes size={13} /></button>
      <button class="icon" title="Delete canvas" onclick={removeCanvas}><Trash2 size={13} /></button>
      <span class="state"><i class:live={saving !== 'conflict'}></i>{saving === 'saving' ? 'Saving…' : saving === 'conflict' ? 'Changed elsewhere: reload' : 'Saved'}</span>
    </Header>
    <div class="flowhost" class:grab={grabbing}>
      <SvelteFlow
        bind:nodes
        bind:edges
        {nodeTypes}
        colorMode="dark"
        minZoom={0.02}
        maxZoom={2}
        panOnDrag={grabbing ? true : [1, 2]}
        selectionOnDrag={!grabbing}
        nodesDraggable={!grabbing}
        nodesConnectable={!grabbing}
        elementsSelectable={!grabbing}
        panOnScroll
        zoomOnScroll={false}
        zoomOnPinch
        zoomOnDoubleClick={false}
        zIndexMode="manual"
        onmove={(_e, v) => (zoom = v.zoom)}
        deleteKey={['Backspace', 'Delete']}
        onconnect={onconnect}
        onnodedragstart={({ targetNode, nodes: dragged }) => {
          remember()
          pickUp(targetNode, dragged)
        }}
        onnodedrag={({ targetNode }) => follow(targetNode)}
        onnodedragstop={({ targetNode }) => {
          follow(targetNode)
          carried = null
          changed()
        }}
        ondelete={changed}
        proOptions={{ hideAttribution: true }}
      >
        <FlowApi
          onready={(api) => {
            flow = api
            setTimeout(opening, 60)
          }}
        />
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} bgColor="#0f0f0f" patternColor="#1c1c1c" />
      </SvelteFlow>

      {#if one}
        <div class="inspector">
          <div class="ih">
            <span>{one.type === 'section' ? 'Frame' : one.type === 'image' ? 'Image' : 'Object'}</span>
            <span class="grow"></span>
            <CopyNode text={md} size={13} />
            <button class="icon" title="Delete" onclick={removeSelected}><Trash2 size={14} /></button>
          </div>
          <input value={(one.data as any).title ?? ''} placeholder="Title" oninput={(e) => patchData(one.id, { title: e.currentTarget.value })} />
          {#if one.type !== 'image'}
            <textarea rows="5" placeholder="Details" value={(one.data as any).body ?? ''} oninput={(e) => patchData(one.id, { body: e.currentTarget.value })}></textarea>
          {/if}
        </div>
      {/if}

      <div class="tools">
        <button class="tool" class:on={tool === 'select' && !space} title="Select (V)" onclick={() => (tool = 'select')}><MousePointer2 size={16} /></button>
        <button class="tool" class:on={grabbing} title="Pan (H, or hold space)" onclick={() => (tool = 'pan')}><Hand size={16} /></button>
        <span class="div"></span>
        <button class="tool" title="Frame (F)" onclick={() => add('section')}><Frame size={16} /></button>
        <button class="tool" title="Sticky note (N)" onclick={() => add('sticky')}><StickyNote size={16} /></button>
        <button class="tool" title="Shape (R)" onclick={() => add('shape')}><Square size={16} /></button>
        <button class="tool" title="Text (T)" onclick={() => add('text')}><Type size={16} /></button>
        <span class="div"></span>
        <button class="tool" title="Zoom out (⌘−)" onclick={() => flow?.zoomOut({ duration: 160 })}><Minus size={16} /></button>
        <button class="tool zoom" title="Fit board (⌘0)" onclick={() => flow?.fitView({ padding: 0.12, duration: 450 })}>{Math.round(zoom * 100)}%</button>
        <button class="tool" title="Zoom in (⌘+)" onclick={() => flow?.zoomIn({ duration: 160 })}><Plus size={16} /></button>
        <span class="div"></span>
        <div class="swatches">
          {#each PALETTE.slice(0, 5) as c}
            <button class="sw" style:border-color={c} title="Colour" disabled={!selected.length} aria-label="Colour" onclick={() => recolor(c)}></button>
          {/each}
        </div>
        <span class="div"></span>
        <button class="tool" title="Undo (⌘Z)" onclick={undo}><Undo2 size={15} /></button>
        <button class="tool" title="Redo (⇧⌘Z)" onclick={redo}><Redo2 size={15} /></button>
      </div>
    </div>
  </div>
{:else}
  <div class="page">
    <Header crumbs={[tabName]}>
      {#if canEditHere()}<button class="primary" onclick={create}><Plus size={12} /><span>New canvas</span></button>{/if}
    </Header>
    <div class="home">
      <h1>{tabName}</h1>
      <div class="grid">
        {#each list as c (c.id)}
          <button class="ccard" onclick={() => go(tabId, c.id)} onmouseenter={() => prefetch(`/canvases/${c.id}`)}>
            <div class="thumb">
              {#if c.thumb}<img src={`data:image/svg+xml;utf8,${encodeURIComponent(c.thumb)}`} alt="" loading="lazy" />{:else}<span class="blank">Empty canvas</span>{/if}
            </div>
            <div class="info">
              <span class="t">{c.title}</span>
              <span class="s">
                <ProjectChip kind="canvas" id={c.id} project={c.project ?? null} onmoved={(p) => (list = list.map((x) => (x.id === c.id ? { ...x, project: p } : x)))} />
                Edited {ago(c.updatedAt)}
              </span>
            </div>
          </button>
        {:else}
          {#if loadingList}
            {#each [0, 1] as _}<div class="ccard sk"><div class="thumb"></div><div class="info"><Skeleton w="65%" h={12} /><Skeleton w="35%" h={10} /></div></div>{/each}
          {:else}
            <div class="empty">
              <Shapes size={20} />
              <p>
                {#if scope.enabled && scope.id}Nothing here yet. New canvases land in this project; to move an existing one, switch to All projects and use its project chip.
                {:else}No canvases yet. Start one for a plan, a flow or a retro.{/if}
              </p>
            </div>
          {/if}
        {/each}
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
  .flowhost {
    flex: 1;
    position: relative;
    min-height: 0;
  }
  .flowhost :global(.svelte-flow) {
    --xy-edge-label-background-color: #0f0f0f;
    --xy-edge-label-background-color-default: #0f0f0f;
    --xy-edge-label-color: #a1a1a1;
    --xy-node-border-radius: 8px;
    --xy-selection-background-color: rgba(237, 237, 237, 0.05);
    --xy-selection-border: 1px solid rgba(237, 237, 237, 0.4);
  }
  .flowhost :global(.svelte-flow__node) {
    background: none;
    border: 0;
    padding: 0;
    box-shadow: none;
  }
  .flowhost :global(.svelte-flow__handle) {
    width: 8px;
    height: 8px;
    background: #0f0f0f;
    border: 1.5px solid #6b6b6b;
    opacity: 0;
  }
  .flowhost :global(.svelte-flow__handle.detail) {
    opacity: 0 !important;
    pointer-events: none;
  }
  .flowhost :global(.svelte-flow__node:hover .svelte-flow__handle),
  .flowhost :global(.svelte-flow__node.selected .svelte-flow__handle) {
    opacity: 1;
  }
  /* With the hand out, the whole board is a thing to grab: over a card too,
     which is the point of the tool. */
  .flowhost.grab :global(.svelte-flow__pane),
  .flowhost.grab :global(.svelte-flow__node) {
    cursor: grab;
  }
  .flowhost.grab :global(.svelte-flow__pane:active),
  .flowhost.grab :global(.svelte-flow__pane.dragging),
  .flowhost.grab :global(.svelte-flow__node:active) {
    cursor: grabbing;
  }
  /* A frame is picked up by its name; the space inside it belongs to the board,
     so a drag there selects or pans instead of dragging the whole frame away. */
  .flowhost :global(.svelte-flow__node-section) {
    pointer-events: none;
  }
  .flowhost :global(.svelte-flow__node-section .framegrip),
  .flowhost :global(.svelte-flow__node-section .svelte-flow__resize-control),
  .flowhost :global(.svelte-flow__node-section .svelte-flow__handle) {
    pointer-events: all;
  }
  .flowhost :global(.framegrip) {
    cursor: grab;
  }
  .flowhost.loading {
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .ccard.sk {
    cursor: default;
  }
  .ccard.sk .info {
    gap: 8px;
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
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.55);
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
    cursor: pointer;
  }
  .tool:hover {
    color: var(--ink);
    background: var(--accent-soft);
  }
  .tool.on {
    background: #2a2a2a;
    color: var(--ink);
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
    background: #2e2e2e;
    margin: 0 2px;
  }
  .swatches {
    display: flex;
    gap: 7px;
    padding: 0 9px;
  }
  .sw {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 2px solid;
    background: none;
    padding: 0;
    cursor: pointer;
  }
  .sw:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .inspector {
    position: absolute;
    top: 16px;
    right: 16px;
    width: 260px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
    border-radius: 10px;
    background: var(--raised);
    border: 1px solid var(--line-strong);
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
    z-index: 5;
  }
  .ih {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted);
  }
  .grow {
    flex: 1;
  }
  .inspector input,
  .inspector textarea {
    font: inherit;
    font-size: 13px;
    color: var(--ink);
    background: var(--bg);
    border: 1px solid var(--line-strong);
    border-radius: var(--r-md);
    padding: 7px 8px;
    resize: vertical;
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
  }
  .frames {
    position: relative;
  }
  .fbtn {
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
  .fbtn b {
    font-family: var(--mono);
    font-weight: 400;
    font-size: 11px;
    color: var(--muted);
  }
  .fmenu {
    position: absolute;
    right: 0;
    top: 34px;
    width: 300px;
    max-height: 420px;
    overflow: auto;
    z-index: 20;
    padding: 6px;
    border-radius: 10px;
    background: var(--raised);
    border: 1px solid var(--line-strong);
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.55);
    display: flex;
    flex-direction: column;
  }
  .fmenu button {
    text-align: left;
    height: 32px;
    flex-shrink: 0;
    padding: 0 10px;
    border: 0;
    border-radius: 6px;
    background: none;
    color: var(--ink-2);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .fmenu button:hover {
    background: #242424;
    color: var(--ink);
  }
  .state {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--muted);
  }
  .state i {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--danger);
  }
  .state i.live {
    background: var(--running);
  }
  .home {
    flex: 1;
    overflow: auto;
    padding: 48px;
    max-width: 1040px;
    width: 100%;
    margin: 0 auto;
    box-sizing: border-box;
  }
  h1 {
    margin: 0 0 28px;
    font-size: 32px;
    font-weight: 600;
    letter-spacing: -0.03em;
  }
  .grid {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
  }
  .ccard {
    width: 300px;
    display: flex;
    flex-direction: column;
    border-radius: 10px;
    border: 1px solid var(--line-strong);
    overflow: hidden;
    background: none;
    padding: 0;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .ccard:hover {
    border-color: #3a3a3a;
  }
  .thumb {
    height: 150px;
    background: var(--raised);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 10px;
    box-sizing: border-box;
  }
  .thumb img {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
  .blank {
    font-size: 12px;
    color: var(--muted);
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
  .empty {
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--muted);
    font-size: 13px;
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
</style>
