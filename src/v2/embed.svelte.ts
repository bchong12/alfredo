// One tab of this site, shown inside the desktop app (see hosted.svelte.ts).
//
// The address carries ?embed=<tab id>&view=<page>. The app that frames the
// page hands over the session it already has and says which page to show;
// this side never stores that session and never renews it, so the app stays
// the only one holding the keys.
import type { Session } from '@supabase/supabase-js'

const q = typeof location === 'undefined' ? new URLSearchParams() : new URLSearchParams(location.search)
const framed = typeof window !== 'undefined' && window.parent !== window

export const embed = $state({
  on: framed && !!q.get('embed'),
  tab: q.get('embed') ?? '',
  view: q.get('view') ?? '',
})

/** Only the app, which is served from this machine. A web page that frames the site is not listened to. */
const APP = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/
let app = ''

const tell = (state: 'hello' | 'ready' | 'expired') => {
  // The first word goes to whoever is outside; it says nothing worth keeping.
  if (embed.on) window.parent.postMessage({ type: 'alfredo:embed', state }, app || '*')
}
export const embedReady = () => tell('ready')
export const embedExpired = () => tell('expired')

/** Start listening. `onsession` gets each session the app hands over, the first and every renewal. */
export function listenToApp(onsession: (s: Session) => void) {
  if (!embed.on) return
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent || !APP.test(e.origin)) return
    app = e.origin
    const m = e.data
    if (m?.type === 'alfredo:session' && typeof m.access_token === 'string' && m.user?.id) {
      onsession({ access_token: m.access_token, refresh_token: '', token_type: 'bearer', expires_in: 3600, expires_at: m.expires_at, user: m.user } as Session)
    } else if (m?.type === 'alfredo:view' && typeof m.view === 'string') embed.view = m.view
  })
  tell('hello')
}
