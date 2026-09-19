// A workspace that lives in Cloudflare: D1 behind a small Worker in the
// owner's own account. The Worker is the only thing that can reach D1 (D1 has
// no direct client auth), so this client speaks its HTTP API with the
// workspace token from the keychain. The token never reaches the browser;
// every call goes through this Mac's server.
//
// The Worker's API (cloudflare/worker.mjs is Alfredo's own):
//   /tasks            board cards        (todo | progress | review | done)
//   /items?type=...   documents, boards (canvases) and meetings, content as JSON
//   /members /invites people
// v2.ts maps those onto Alfredo's four tabs.

export class CloudflareError extends Error {
  constructor(message: string, public status: number) {
    super(message)
  }
}

export class CloudflareWorkspace {
  constructor(public url: string, private token: string) {}

  async call<T = any>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const res = await fetch(`${this.url}/api/workspace${path}`, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    })
    const text = await res.text()
    let data: any = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = text
    }
    if (!res.ok) throw new CloudflareError(data?.error ?? `Cloudflare workspace answered ${res.status}`, res.status)
    return data as T
  }

  /** A file the Worker serves under its own origin (board images). */
  raw(path: string) {
    return fetch(`${this.url}${path}`, { headers: { authorization: `Bearer ${this.token}` } })
  }

  /** Cheap reachability check for the Database screen. */
  async ping() {
    const s = await this.call<{ user: { email: string; name: string } | null; storage: string }>('/session')
    return { ok: !!s.user, user: s.user, storage: s.storage }
  }
}
