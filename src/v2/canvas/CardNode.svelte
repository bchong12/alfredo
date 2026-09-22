<script lang="ts">
  // Cards, stickies, shapes and text. Imported Miro variants keep Miro's
  // proportions: big centred text that fills the box, the way the board was drawn.
  import { NodeResizer, type NodeProps } from '@xyflow/svelte'
  import Handles from './Handles.svelte'
  import { toneOf } from './tone'
  let { data, selected, type }: NodeProps = $props()
  const d = $derived(data as { title?: string; body?: string; kind?: string; color?: string; variant?: string; status?: string })
  const tone = $derived(toneOf(d))
  const variant = $derived(d.variant ?? 'default')
  const KIND_LABEL: Record<string, string> = { entry: 'Lead source', person: 'Person', software: 'Software', question: 'Open question', clarification: 'Clarification', step: 'Step' }
  /** **bold** runs inside a body, as the source board writes them. */
  const parts = (s: string) => s.split(/(\*\*[^*]+\*\*)/g).map((p) => (p.startsWith('**') && p.endsWith('**') ? { b: true, t: p.slice(2, -2) } : { b: false, t: p }))
</script>

<NodeResizer isVisible={selected} minWidth={60} minHeight={30} lineStyle="border-color:var(--ink)" handleStyle="background:var(--ink);border:0" />
<Handles />
<div class="node {type} v-{variant} kind-{d.kind}" class:sel={selected} style:--line={tone.line} style:--fill={tone.fill} style:--text={tone.text}>
  {#if type === 'card' && variant === 'default' && d.kind && KIND_LABEL[d.kind]}<span class="kind">{KIND_LABEL[d.kind]}</span>{/if}
  {#if d.title && !(variant === 'miro-card' && d.title === 'Virtual rep and field rep')}<strong>{d.title}</strong>{/if}
  {#if d.body}<p>{#each parts(d.body) as p}{#if p.b}<b>{p.t}</b>{:else}{p.t}{/if}{/each}</p>{/if}
</div>

<style>
  .node {
    width: 100%;
    height: 100%;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 12px 14px;
    border-radius: 8px;
    border: 1.5px solid var(--line);
    background: var(--fill);
    color: var(--text);
    overflow: hidden;
    font-family: inherit;
  }
  .sel {
    outline: 1.5px solid var(--ink);
    outline-offset: 4px;
  }
  .kind {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--muted);
  }
  strong {
    font-size: 13px;
    font-weight: 600;
    line-height: 1.3;
    white-space: pre-wrap;
  }
  p {
    margin: 0;
    font-size: 12px;
    line-height: 1.5;
    opacity: 0.85;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  b {
    font-weight: 700;
  }

  /* Miro's own card, mini-card and strip: centred, sized to fill the box. */
  .v-miro-card,
  .v-miro-mini,
  .v-miro-strip {
    border-radius: 10px;
    padding: 12px 28px;
    align-items: center;
    justify-content: center;
    text-align: center;
  }
  .v-miro-card strong {
    font-size: 26px;
    line-height: 1.22;
    font-weight: 700;
  }
  .v-miro-card p {
    font-size: 24px;
    line-height: 1.32;
    opacity: 1;
  }
  .v-miro-mini {
    padding: 8px 18px;
  }
  .v-miro-mini strong {
    font-size: 24px;
    line-height: 1.18;
    font-weight: 700;
  }
  .v-miro-mini p {
    font-size: 19px;
    line-height: 1.26;
    opacity: 1;
  }
  .v-miro-mini.kind-note strong {
    font-size: 32px;
  }
  .v-miro-strip strong {
    font-size: 26px;
    font-weight: 750;
  }
  .v-miro-strip p {
    font-size: 20px;
    opacity: 1;
  }

  /* Free text: no box. Labels are Miro's section headings; captions its small print. */
  .text {
    border-color: transparent;
    background: none;
    padding: 6px;
    color: var(--ink);
  }
  .text strong {
    font-size: 26px;
  }
  .text.v-miro-label {
    padding: 0;
    justify-content: center;
  }
  .text.v-miro-label strong {
    font-size: 34px;
    font-weight: 700;
    line-height: 1.2;
  }
  .text.v-miro-label p {
    font-size: 18px;
    color: var(--muted);
  }
  .text.v-miro-caption {
    padding: 0;
    justify-content: flex-start;
  }
  .text.v-miro-caption strong {
    font-size: 13px;
    font-weight: 400;
    color: var(--muted);
  }
  .shape {
    align-items: center;
    justify-content: center;
    text-align: center;
    border-radius: 13px;
  }
  .sticky {
    border-radius: 4px;
  }
</style>
