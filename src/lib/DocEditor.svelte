<script lang="ts">
  import { Crepe } from '@milkdown/crepe'
  import { replaceAll } from '@milkdown/kit/utils'
  import { untrack } from 'svelte'
  import '@milkdown/crepe/theme/common/style.css'
  import '@milkdown/crepe/theme/classic-dark.css'

  /**
   * Crepe is markdown in and markdown out, which is why it was chosen over the
   * React-only Notion clones: docs.body is markdown and docs.fts is a
   * generated tsvector over it, so an HTML-first editor would have broken
   * search.
   */
  let {
    value,
    onchange,
    placeholder = 'Start writing, or press / for blocks',
    autofocus = false,
  }: { value: string; onchange: (markdown: string) => void; placeholder?: string; autofocus?: boolean } = $props()

  let host = $state<HTMLDivElement | null>(null)
  let crepe: Crepe | null = null

  /** Put the cursor in the writing, at the end. The page calls this when someone clicks it. */
  export function focus(atEnd = true) {
    const pm = host?.querySelector('.ProseMirror') as HTMLElement | null
    if (!pm) return
    pm.focus()
    if (!atEnd) return
    const sel = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(pm)
    range.collapse(false)
    sel?.removeAllRanges()
    sel?.addRange(range)
  }

  /**
   * The markdown the editor is known to hold: what it was seeded with, or the
   * last thing it emitted. The page saves what we emit and hands it straight
   * back as `value`, and without this the editor would treat its own writing
   * as an outside change and reload itself under the cursor.
   */
  let held = ''

  $effect(() => {
    const el = host
    if (!el) return

    // Lifecycle deliberately kept out of $state: reading a $state before the
    // first await inside an effect re-triggers it, which is an infinite loop.
    let live = true
    let editor: Crepe | null = null

    // Only `host` may rebuild the editor. Reading the writing here would make
    // every keystroke tear it down and put it back — the cursor jumps to the
    // end, the selection goes, and whatever was typed in between is lost.
    const seed = untrack(() => value)
    held = seed
    const c = new Crepe({
      root: el,
      defaultValue: seed,
      features: {
        [Crepe.Feature.CodeMirror]: true,
        [Crepe.Feature.BlockEdit]: true,
        [Crepe.Feature.Toolbar]: true,
        [Crepe.Feature.LinkTooltip]: true,
        [Crepe.Feature.ListItem]: true,
        [Crepe.Feature.Cursor]: true,
        [Crepe.Feature.Table]: true,
        [Crepe.Feature.Placeholder]: true,
        // Off on purpose: image upload has nowhere to go yet, and the AI and
        // LaTeX panels would be dead controls.
        [Crepe.Feature.ImageBlock]: false,
        [Crepe.Feature.Latex]: false,
        [Crepe.Feature.AI]: false,
      },
      featureConfigs: {
        [Crepe.Feature.Placeholder]: { text: untrack(() => placeholder), mode: 'block' },
      },
    })

    /* The editor writes Markdown its own way (a table re-spaced, a list marker
       changed), so merely being handed a doc makes it report "changed", and
       opening a doc saved it: "Edited just now" on a page nobody touched, a
       revision bumped under whoever else had it open. A change is one a person
       made, so nothing is reported until they have put a hand on the editor. */
    let touched = false
    const touch = () => (touched = true)
    const HANDS = ['keydown', 'beforeinput', 'paste', 'cut', 'drop', 'pointerdown'] as const
    for (const name of HANDS) el.addEventListener(name, touch, true)

    c.on((listener) => {
      listener.markdownUpdated((_ctx, markdown) => {
        if (!live || !touched) return
        held = markdown
        onchange(markdown)
      })
    })

    const wantsFocus = untrack(() => autofocus)
    c.create().then(() => {
      if (!live) return void c.destroy()
      editor = c
      crepe = c
      // The writing may have finished loading while the editor was starting.
      const now = untrack(() => value)
      if (now !== held) {
        held = now
        c.editor.action(replaceAll(now))
      }
      // A blank doc should take what you type, rather than swallow it.
      if (wantsFocus) requestAnimationFrame(() => focus(true))
    })

    return () => {
      live = false
      for (const name of HANDS) el.removeEventListener(name, touch, true)
      editor?.destroy()
      crepe = null
    }
  })

  /**
   * Writing that arrived from somewhere else: the doc finished loading behind
   * the cached copy, or a teammate saved. It is put in only when it really is
   * different and nobody is typing, so an open cursor is never disturbed.
   */
  $effect(() => {
    const next = value
    untrack(() => {
      if (!crepe || next === held || next === crepe.getMarkdown()) return
      const pm = host?.querySelector('.ProseMirror')
      if (pm && (pm === document.activeElement || pm.contains(document.activeElement))) return
      held = next
      crepe.editor.action(replaceAll(next))
    })
  })
</script>

<div class="editor" bind:this={host}></div>

<style>
  /* Crepe ships its own palette and typefaces; both are replaced so the editor
     is part of the page rather than a widget dropped into it. */
  .editor,
  .editor :global(.milkdown) {
    --crepe-color-background: transparent;
    --crepe-color-on-background: var(--ink);
    --crepe-color-surface: var(--panel);
    --crepe-color-surface-low: var(--raised);
    --crepe-color-on-surface: var(--ink);
    --crepe-color-on-surface-variant: var(--muted);
    --crepe-color-outline: var(--line-strong);
    --crepe-color-primary: var(--ink);
    --crepe-color-secondary: var(--raised);
    --crepe-color-on-secondary: var(--ink);
    --crepe-color-inverse: var(--ink);
    --crepe-color-on-inverse: var(--bg);
    --crepe-color-inline-code: var(--ink);
    --crepe-color-inline-area: var(--raised);
    --crepe-color-error: var(--danger);
    --crepe-color-hover: var(--raised);
    --crepe-color-selected: var(--accent-soft);
    --crepe-font-default: 'Geist Variable', ui-sans-serif, -apple-system, system-ui, sans-serif;
    --crepe-font-title: 'Geist Variable', ui-sans-serif, -apple-system, system-ui, sans-serif;
    --crepe-font-code: 'Geist Mono Variable', ui-monospace, SFMono-Regular, Menlo, monospace;
    --crepe-shadow-1: var(--shadow-md);
    --crepe-shadow-2: var(--shadow-md);
  }

  .editor :global(.milkdown) { background: transparent; font-family: var(--crepe-font-default); }
  .editor :global(.ProseMirror) {
    padding: 0;
    font-family: var(--crepe-font-default);
    font-size: 15px;
    line-height: 1.7;
    color: var(--ink);
    min-height: 40vh;
  }
  .editor :global(.ProseMirror:focus) { outline: none; }
  .editor :global(.ProseMirror > *) { margin: 0 0 var(--sp-4); }
  .editor :global(.ProseMirror h1),
  .editor :global(.ProseMirror h2),
  .editor :global(.ProseMirror h3),
  .editor :global(.ProseMirror h4) {
    font-family: var(--crepe-font-title);
    color: var(--ink);
    font-weight: 600;
    letter-spacing: -0.015em;
    line-height: 1.3;
    margin: var(--sp-7) 0 var(--sp-3);
  }
  .editor :global(.ProseMirror > h1:first-child),
  .editor :global(.ProseMirror > h2:first-child),
  .editor :global(.ProseMirror > h3:first-child) { margin-top: 0; }
  .editor :global(.ProseMirror h1) { font-size: 24px; }
  .editor :global(.ProseMirror h2) { font-size: 19px; }
  .editor :global(.ProseMirror h3) { font-size: 16px; }
  .editor :global(.ProseMirror h4) { font-size: 15px; color: var(--ink-2); }
  .editor :global(.ProseMirror p) { margin: 0 0 var(--sp-4); }
  .editor :global(.ProseMirror a) { color: var(--ink); text-decoration: underline; text-underline-offset: 3px; text-decoration-color: var(--line-strong); }
  .editor :global(.ProseMirror strong) { font-weight: 600; }
  .editor :global(.ProseMirror ul), .editor :global(.ProseMirror ol) { padding-left: 22px; }
  .editor :global(.ProseMirror li) { margin: 2px 0; }
  .editor :global(.ProseMirror li::marker) { color: var(--muted); }
  .editor :global(.ProseMirror code),
  .editor :global(.ProseMirror :not(pre) > code) {
    font-family: var(--crepe-font-code);
    font-size: 13px;
    color: var(--ink);
    background: var(--raised);
    border: 1px solid var(--line);
    border-radius: var(--r-sm);
    padding: 1px 5px;
  }
  .editor :global(.ProseMirror pre),
  .editor :global(.milkdown-code-block) {
    font-family: var(--crepe-font-code);
    font-size: 13px;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: var(--r-lg);
  }
  .editor :global(.ProseMirror blockquote) {
    margin: 0 0 var(--sp-4);
    padding: var(--sp-1) 0 var(--sp-1) var(--sp-5);
    border-left: 2px solid var(--line-strong);
    color: var(--ink-2);
    font-style: normal;
  }
  .editor :global(.ProseMirror hr) { border: 0; border-top: 1px solid var(--line); margin: var(--sp-6) 0; }
  .editor :global(.ProseMirror table) {
    border-collapse: collapse;
    width: 100%;
    font-size: 14px;
    margin: var(--sp-2) 0 var(--sp-5);
  }
  .editor :global(.ProseMirror th), .editor :global(.ProseMirror td) {
    border: 1px solid var(--line);
    padding: var(--sp-2) var(--sp-3);
    text-align: left;
    vertical-align: top;
  }
  .editor :global(.ProseMirror th) { background: var(--panel); color: var(--ink-2); font-weight: 500; font-size: 13px; }
  .editor :global(.ProseMirror .selectedCell) { background: var(--accent-soft); }
  /* Crepe's placeholder and block handles, kept quiet. The drag handle is
     what made the cursor flicker between text and grab as the mouse moved;
     it stays available on hover but never changes the cursor elsewhere. */
  .editor :global(.crepe-placeholder) { color: var(--muted); }
  .editor :global(.ProseMirror) { cursor: text; }
  .editor :global(.ProseMirror *) { cursor: inherit; }
  .editor :global(.ProseMirror a) { cursor: pointer; }
  .editor :global(.milkdown-block-handle) { color: var(--muted); opacity: 0; transition: opacity 120ms; }
  .editor :global(.milkdown-block-handle:hover), .editor:hover :global(.milkdown-block-handle) { opacity: 1; }
  .editor :global(.milkdown-block-handle .operation-item) { cursor: pointer; }
  .editor :global(.milkdown-block-handle [data-drag-handle]), .editor :global(.milkdown-block-handle .drag-handle) { cursor: grab; }
  .editor :global(.milkdown-slash-menu), .editor :global(.milkdown-toolbar), .editor :global(.milkdown-link-preview), .editor :global(.milkdown-link-edit) {
    font-family: var(--crepe-font-default);
    background: var(--panel);
    border: 1px solid var(--line-strong);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-md);
    color: var(--ink);
  }
  .editor :global(.milkdown-toolbar button), .editor :global(.milkdown-slash-menu button) { cursor: pointer; }
</style>
