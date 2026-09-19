<script lang="ts">
  // ALFREDO built the same way as the mark: each letter is five rows on a 3x5
  // grid of rounded blocks, and runs of blocks in a row fuse into one bar. The
  // A is the mark itself. Height drives the size; currentColor fills it.
  let { height = 10, class: klass = '' }: { height?: number; class?: string } = $props()

  const GLYPHS: Record<string, string[]> = {
    A: ['011', '101', '111', '101', '101'],
    L: ['100', '100', '100', '100', '111'],
    F: ['111', '100', '110', '100', '100'],
    R: ['110', '101', '110', '101', '101'],
    E: ['111', '100', '110', '100', '111'],
    D: ['110', '101', '101', '101', '110'],
    O: ['011', '101', '101', '101', '110'],
  }
  const WORD = 'ALFREDO'
  // Same geometry as Logo.svelte (viewBox 115x174 per letter).
  const PITCH = 36.6 // block to block, both axes
  const BLOCK = 35.598
  const ROW_H = 26.45
  const X0 = 2.787
  const Y0 = 0.652
  const ADVANCE = PITCH * 4 // three columns plus one empty column between letters

  const bars = (() => {
    const out: { x: number; y: number; w: number }[] = []
    ;[...WORD].forEach((ch, i) => {
      GLYPHS[ch].forEach((row, r) => {
        let c = 0
        while (c < 3) {
          if (row[c] !== '1') { c++; continue }
          let e = c
          while (e + 1 < 3 && row[e + 1] === '1') e++
          out.push({ x: i * ADVANCE + X0 + c * PITCH, y: Y0 + r * PITCH, w: BLOCK + (e - c) * PITCH })
          c = e + 1
        }
      })
    })
    return out
  })()
  const VW = (WORD.length - 1) * ADVANCE + 115
  const VH = 174
  const width = $derived((height * VW) / VH)
</script>

<svg {width} {height} viewBox="0 0 {VW} {VH}" fill="currentColor" class={klass} aria-label="Alfredo" role="img">
  {#each bars as b}
    <rect x={b.x} y={b.y} width={b.w} height={ROW_H} rx="6" />
  {/each}
</svg>
