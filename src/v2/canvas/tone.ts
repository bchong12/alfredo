// Canvas colours. Every object is an outline in its colour over a faint tint
// of it, on whichever ground the theme has. Boards imported from Miro carry
// Miro's pale fills; each maps to the outline colour Miro itself uses for that
// fill. Text is that colour pulled toward the theme's ink, so it reads on a
// dark ground and a light one alike.
export const PALETTE = ['#E3D3B0', '#B4C3D3', '#B7C7AE', '#DDB6A1', '#C7BDD6', '#E8D9A0', '#D6D1C8']

const MIRO: Record<string, string> = {
  '#f1f6ff': '#5c8fff',
  '#ebfff3': '#17cb61',
  '#fff9e8': '#e5bd4c',
  '#f5f1ff': '#aa8de2',
  '#fff0d9': '#e69b55',
  '#a9e467': '#7dad39',
  '#ffe777': '#d9b834',
  '#ffc08b': '#d88132',
  '#a9e9fb': '#5eb4cd',
}

const KIND: Record<string, string> = {
  entry: '#E3D3B0',
  person: '#B4C3D3',
  software: '#B7C7AE',
  question: '#E8D9A0',
  step: '#D6D1C8',
  note: '#9a9a9a',
  clarification: '#9a9a9a',
}

function rgb(h: string) {
  const m = /^#?([0-9a-f]{6})$/i.exec(h.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export function toneOf(data: { color?: string; kind?: string }) {
  const key = data.color?.toLowerCase()
  const miro = key ? MIRO[key] : undefined
  const line = miro ?? (key && key !== '#ffffff' && key !== '#fff' && rgb(key) ? key : (KIND[data.kind ?? ''] ?? '#8a8a8a'))
  const c = rgb(line) ?? [138, 138, 138]
  return { line, fill: `rgba(${c.join(',')},0.08)`, text: miro ? `color-mix(in srgb, ${line} 55%, var(--ink))` : 'var(--ink)' }
}
