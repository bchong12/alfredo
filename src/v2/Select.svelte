<script lang="ts">
  // One dropdown for the whole app, because the system one cannot be made to
  // sit right: its caret is drawn by the platform, at the platform's size and
  // spacing, and it ignores the app's type and colours.
  //
  // Keyboard: Enter or Space opens, arrows move, Enter picks, Escape closes.
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import Check from '@lucide/svelte/icons/check'

  export type Option = { value: string; label: string; hint?: string; dot?: string }

  let {
    value = '',
    options,
    onchange,
    placeholder = 'Choose',
    disabled = false,
    width,
    align = 'left',
    ariaLabel,
  }: {
    value?: string
    options: Option[]
    onchange: (v: string) => void
    placeholder?: string
    disabled?: boolean
    /** A fixed width, when a row of them should line up. */
    width?: string
    align?: 'left' | 'right'
    ariaLabel?: string
  } = $props()

  let open = $state(false)
  let active = $state(0)
  let root = $state<HTMLDivElement | null>(null)
  const current = $derived(options.find((o) => o.value === value) ?? null)

  /* The list is drawn over the whole window, not inside whatever the field
     sits in. A row that clips its own overflow (the people lists in Settings
     do, to keep long names on one line) used to clip the list with it: the
     dropdown opened, and nothing showed. Placed from where the field is on
     screen, under it, or above it near the bottom of the window. */
  let at = $state({ left: 0, top: 0, width: 0, up: false })
  function place() {
    if (!root) return
    const r = root.getBoundingClientRect()
    const height = Math.min(260, options.length * 28 + 10)
    const up = r.bottom + 4 + height > window.innerHeight - 8 && r.top - 4 - height > 8
    at = { left: r.left, top: up ? r.top - 4 - height : r.bottom + 4, width: r.width, up }
  }
  function show() {
    if (disabled) return
    active = Math.max(0, options.findIndex((o) => o.value === value))
    place()
    open = true
  }
  function floated(node: HTMLElement) {
    document.body.appendChild(node)
    return { destroy: () => node.remove() }
  }

  function pick(v: string) {
    open = false
    if (v !== value) onchange(v)
  }

  function onkey(e: KeyboardEvent) {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault()
        show()
      }
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      open = false
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      active = (active + 1) % options.length
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      active = (active - 1 + options.length) % options.length
    } else if (e.key === 'Enter') {
      e.preventDefault()
      pick(options[active]?.value ?? value)
    }
  }
</script>

<div class="sel" bind:this={root} style:width={width}>
  <button
    type="button"
    class="field"
    class:open
    {disabled}
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-label={ariaLabel}
    onclick={(e) => (e.stopPropagation(), open ? (open = false) : show())}
    onkeydown={onkey}
  >
    {#if current?.dot}<i class="dot {current.dot}"></i>{/if}
    <span class="label" class:placeholder={!current}>{current?.label ?? placeholder}</span>
    <ChevronDown size={13} class="caret" />
  </button>

  {#if open}
    <div class="layer" use:floated>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="catch" onclick={(e) => (e.stopPropagation(), (open = false))} onwheel={() => (open = false)}></div>
    <div
      class="menu"
      role="listbox"
      tabindex="-1"
      style:top="{at.top}px"
      style:min-width="{at.width}px"
      style:left={align === 'right' ? 'auto' : `${at.left}px`}
      style:right={align === 'right' ? `${Math.max(8, window.innerWidth - at.left - at.width)}px` : 'auto'}
    >
      {#each options as o, i (o.value)}
        <button
          type="button"
          class="opt"
          class:on={o.value === value}
          class:active={i === active}
          role="option"
          aria-selected={o.value === value}
          onmouseenter={() => (active = i)}
          onclick={(e) => (e.stopPropagation(), pick(o.value))}
        >
          {#if o.dot}<i class="dot {o.dot}"></i>{/if}
          <span class="t">{o.label}</span>
          {#if o.hint}<span class="hint">{o.hint}</span>{/if}
          {#if o.value === value}<Check size={12} />{/if}
        </button>
      {/each}
    </div>
    </div>
  {/if}
</div>

<svelte:window onresize={() => (open = false)} />

<style>
  .sel {
    position: relative;
    display: inline-flex;
    min-width: 0;
  }
  button {
    font: inherit;
    color: inherit;
    cursor: pointer;
  }
  .field {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    height: 32px;
    padding: 0 8px 0 10px;
    border-radius: var(--r-md);
    border: 1px solid var(--line-strong);
    background: var(--bg);
    font-size: var(--fs-2);
    text-align: left;
  }
  .field:hover:not(:disabled) {
    border-color: var(--muted);
  }
  .field.open {
    border-color: var(--muted);
    background: var(--raised);
  }
  .field:disabled {
    opacity: 0.55;
    cursor: default;
  }
  .label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .placeholder {
    color: var(--muted);
  }
  /* The caret sits where it should, the same distance in every dropdown. */
  .field :global(.caret) {
    flex-shrink: 0;
    color: var(--muted);
    transition: transform 0.14s ease;
  }
  .field.open :global(.caret) {
    transform: rotate(180deg);
  }
  .layer {
    position: fixed;
    inset: 0;
    z-index: 95;
    font-size: var(--fs-3);
    color: var(--ink);
  }
  .catch {
    position: absolute;
    inset: 0;
  }
  .menu {
    position: fixed;
    max-height: 260px;
    overflow: auto;
    padding: 4px;
    border-radius: var(--r-lg);
    background: var(--panel);
    border: 1px solid var(--line-strong);
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.45);
  }
  .opt {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    height: 28px;
    padding: 0 8px;
    border: 0;
    border-radius: var(--r-md);
    background: none;
    color: var(--ink-2);
    font-size: var(--fs-2);
    white-space: nowrap;
  }
  .opt.active {
    background: var(--accent-soft);
    color: var(--ink);
  }
  .opt.on {
    color: var(--ink);
  }
  .t {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    text-align: left;
  }
  .hint {
    color: var(--muted);
    font-size: var(--fs-1);
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
    background: var(--muted);
  }
  .dot.none {
    background: none;
    border: 1px dashed var(--line-strong);
  }
  .dot.blue { background: #6aa6ff; }
  .dot.green { background: #6fcf97; }
  .dot.amber { background: #e7b75f; }
  .dot.rose { background: #f28ba8; }
  .dot.violet { background: #b38cf0; }
  .dot.teal { background: #5fd0c5; }
  .dot.orange { background: #f0955f; }
  .dot.slate { background: #8d97a8; }
</style>
