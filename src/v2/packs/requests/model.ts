// Requests: what people ask of a product, bugs and ideas both, with votes,
// a status, and the card it became. One board per product, kept as pack
// data "requests.<product>" so it works on every kind of database, an agent
// reads it with get_pack_data, and a public form (the Peach portal) can
// append to it through the workspace's own Worker. Which products exist is
// "requests.settings".

export type Kind = 'bug' | 'request'
export type Status = 'new' | 'review' | 'planned' | 'progress' | 'done' | 'declined'
export type Via = 'team' | 'portal'

export type Request = {
  id: string
  kind: Kind
  title: string
  body: string
  status: Status
  /** Who wants it: one entry per person (an email, or a person id in the app). */
  votes: string[]
  by: { name: string; email?: string; via: Via }
  createdAt: string
  updatedAt: string
  /** The team's word back, shown to whoever asked. */
  reply?: string
  /** The board card it became, when it did. */
  card?: { id: string; ref: string } | null
}
export type Board = { items: Request[] }
export type Product = { id: string; label: string }
export type Settings = { products: Product[] }

export const EMPTY: Board = { items: [] }
export const DEFAULT_SETTINGS: Settings = { products: [{ id: 'general', label: 'General' }] }

export const STATUSES: { value: Status; label: string }[] = [
  { value: 'new', label: 'New' },
  { value: 'review', label: 'Under review' },
  { value: 'planned', label: 'Planned' },
  { value: 'progress', label: 'In progress' },
  { value: 'done', label: 'Done' },
  { value: 'declined', label: 'Declined' },
]
export const KINDS: { value: Kind; label: string }[] = [
  { value: 'request', label: 'Request' },
  { value: 'bug', label: 'Bug' },
]
export const statusLabel = (s: Status) => STATUSES.find((x) => x.value === s)?.label ?? s
/** Over: nothing more will happen to it. */
export const settled = (s: Status) => s === 'done' || s === 'declined'

export const tidy = (raw: unknown): Board => {
  const b = (raw && typeof raw === 'object' ? raw : {}) as Partial<Board>
  const items = Array.isArray(b.items) ? b.items : []
  return {
    items: items
      .filter((r): r is Request => !!r && typeof r === 'object' && typeof (r as Request).id === 'string' && typeof (r as Request).title === 'string')
      .map((r) => ({
        ...r,
        kind: r.kind === 'bug' ? 'bug' : 'request',
        status: STATUSES.some((s) => s.value === r.status) ? r.status : 'new',
        votes: Array.isArray(r.votes) ? r.votes.filter((v) => typeof v === 'string') : [],
        body: typeof r.body === 'string' ? r.body : '',
        by: r.by && typeof r.by === 'object' ? { name: String(r.by.name ?? 'Someone'), email: r.by.email, via: r.by.via === 'portal' ? 'portal' : 'team' } : { name: 'Someone', via: 'team' },
      })),
  }
}
export const tidySettings = (raw: unknown): Settings => {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Partial<Settings>
  const products = (Array.isArray(s.products) ? s.products : []).filter((p): p is Product => !!p && typeof p.id === 'string' && typeof p.label === 'string' && /^[a-z0-9-]+$/.test(p.id))
  return { products: products.length ? products : DEFAULT_SETTINGS.products }
}

/** The order a board reads in: open first, most wanted first, newest first. */
export const ranked = (items: Request[]) =>
  [...items].sort((a, b) => Number(settled(a.status)) - Number(settled(b.status)) || b.votes.length - a.votes.length || b.createdAt.localeCompare(a.createdAt))

/** A short id that is fine in a URL and unlikely to collide. */
export const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)

/** How long ago, in a word or two. */
export const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  if (s < 86400 * 14) return `${Math.floor(s / 86400)}d ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
