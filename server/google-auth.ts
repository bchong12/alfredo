// Sign in with Google, for a workspace whose Supabase project has the
// provider switched on.
//
// Google refuses to sign people in inside an app window, so the browser does
// it: Alfredo opens the project's authorize URL, Google returns to a page
// this server holds on 127.0.0.1, and that page hands the session back. The
// tokens live in the URL fragment, which never reaches a server by itself, so
// the page posts them here and the app collects them once.

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'

type Pending = { workspace: string; at: number; session?: { access_token: string; refresh_token: string }; error?: string }
const waiting = new Map<string, Pending>()

const sweep = () => {
  for (const [k, v] of waiting) if (Date.now() - v.at > 10 * 60_000) waiting.delete(k)
}

/** Where Google should come back to. The app serves this page itself. */
export const callbackUrl = (port: number) => `http://127.0.0.1:${port}/auth/callback`

export function startGoogle(o: { workspace: string; supabaseUrl: string; port: number }) {
  sweep()
  const state = randomBytes(16).toString('base64url')
  waiting.set(state, { workspace: o.workspace, at: Date.now() })
  const redirect = `${callbackUrl(o.port)}?state=${encodeURIComponent(state)}`
  const url = `${o.supabaseUrl}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirect)}`
  // The system browser, because Google will not sign anyone in inside an app.
  spawn('open', [url], { stdio: 'ignore', detached: true }).unref()
  return { state, url }
}

export function finishGoogle(state: string, r: { access_token?: string; refresh_token?: string; error?: string }) {
  const p = waiting.get(state)
  if (!p) return false
  if (r.error) p.error = r.error
  else if (r.access_token && r.refresh_token) p.session = { access_token: r.access_token, refresh_token: r.refresh_token }
  return true
}

/** The app asks until Google is done. A session is handed over once. */
export function collectGoogle(state: string) {
  const p = waiting.get(state)
  if (!p) return { status: 'unknown' as const }
  if (p.error) {
    waiting.delete(state)
    return { status: 'failed' as const, error: p.error }
  }
  if (p.session) {
    waiting.delete(state)
    return { status: 'done' as const, session: p.session, workspace: p.workspace }
  }
  return { status: 'waiting' as const }
}

/** The page Google returns to: it moves the session out of the fragment and closes. */
export const CALLBACK_PAGE = `<!doctype html>
<meta charset="utf-8" />
<title>Signing in to Alfredo</title>
<style>
  body { font: 15px -apple-system, system-ui, sans-serif; color: #e8e8e8; background: #0f0f0f;
         height: 100vh; margin: 0; display: grid; place-items: center; }
  p { opacity: 0.75 }
</style>
<h1 id="h">Signing you in…</h1>
<p id="p">You can close this window in a moment.</p>
<script>
  const state = new URLSearchParams(location.search).get('state')
  const hash = new URLSearchParams(location.hash.slice(1))
  const body = {
    state,
    access_token: hash.get('access_token'),
    refresh_token: hash.get('refresh_token'),
    error: hash.get('error_description') || hash.get('error') || new URLSearchParams(location.search).get('error_description'),
  }
  fetch('/auth/callback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then(() => {
      document.getElementById('h').textContent = body.error ? 'That did not work' : 'Done'
      document.getElementById('p').textContent = body.error || 'Back to Alfredo. You can close this window.'
      if (!body.error) setTimeout(() => window.close(), 800)
    })
</script>`
