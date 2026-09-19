// Canvas colours. Dark ground, every object an outline in its colour over a
// faint tint of it. Boards imported from Miro carry Miro's pale fills; each
// maps to the outline and text colour Miro itself uses for that fill, lifted
// so it reads on dark.
export const PALETTE = ['#E3D3B0', '#B4C3D3', '#B7C7AE', '#DDB6A1', '#C7BDD6', '#E8D9A0', '#D6D1C8']

const MIRO: Record<string, { line: string; text: string }> = {
  '#f1f6ff': { line: '#5c8fff', text: '#a9c3ff' },
  '#ebfff3': { line: '#17cb61', text: '#86e3ab' },
  '#fff9e8': { line: '#e5bd4c', text: '#f0d68c' },
  '#f5f1ff': { line: '#aa8de2', text: '#cdbcf0' },
  '#fff0d9': { line: '#e69b55', text: '#f2c393' },
  '#a9e467': { line: '#7dad39', text: '#bde38c' },
  '#ffe777': { line: '#d9b834', text: '#f0da7a' },
  '#ffc08b': { line: '#d88132', text: '#f2b27a' },
  '#a9e9fb': { line: '#5eb4cd', text: '#a5dbeb' },
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
  const line = miro?.line ?? (key && key !== '#ffffff' && key !== '#fff' && rgb(key) ? key : (KIND[data.kind ?? ''] ?? '#8a8a8a'))
  const c = rgb(line) ?? [138, 138, 138]
  return { line, fill: `rgba(${c.join(',')},0.08)`, text: miro?.text ?? '#ededed' }
}
