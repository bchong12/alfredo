// The invite link: everything a teammate's Alfredo needs to reach a workspace
// and say who they are. Where it is, the publishable key (safe in a browser),
// and the invitation itself. No secret travels in it; what they may see once
// they are in is the database's decision, not the link's.

const PREFIX = 'alfredo:join:'

export type InvitePayload = {
  /** Which kind of workspace the link opens. */
  kind: 'supabase' | 'cloudflare'
  url: string
  /** Supabase only: the publishable key, which is safe to hand out. */
  anonKey?: string
  name: string
  token: string
}

export const inviteLink = (p: InvitePayload) => PREFIX + Buffer.from(JSON.stringify(p)).toString('base64url')

export function readInviteLink(link: string): InvitePayload {
  const raw = link.trim().replace(/^.*alfredo:join:/, '')
  let p: Partial<InvitePayload>
  try {
    p = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    throw new Error('That does not look like an invite link.')
  }
  const kind = p.kind === 'cloudflare' ? 'cloudflare' : 'supabase'
  if (!p.url || !p.token || (kind === 'supabase' && !p.anonKey)) throw new Error('That invite link is incomplete. Ask for a new one.')
  return { kind, url: p.url, anonKey: p.anonKey, name: p.name?.trim() || 'Workspace', token: p.token }
}
