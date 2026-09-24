// A newer Alfredo, downloaded by the shell and waiting: the page says so once
// and offers the restart. Only the desktop app has a shell to hear from.
declare global {
  interface Window {
    alfredo?: {
      onUpdate: (cb: (info: { version: string }) => void) => void
      onUpdateState: (cb: (s: UpdateState) => void) => void
      installUpdate: () => void
      checkForUpdate: () => Promise<{ version?: string | null; error?: string }>
      version: string
      notify: (n: { id: string; title: string; body?: string; action?: string; silent?: boolean }) => void
      onNotificationAction: (cb: (r: { id: string; action: string }) => void) => void
    }
  }
}

export type UpdateState = { state: 'checking' | 'latest' | 'downloading' | 'ready' | 'error' | 'unmanaged'; at: number; version?: string; latest?: string | null; percent?: number; notes?: string; error?: string }

export const update = $state<{
  /** A newer Alfredo, downloaded and waiting. */
  version: string | null
  dismissed: boolean
  /** The last thing the shell said about updates, for the Settings page. */
  last: UpdateState | null
  /** What the shell is doing right now, or '' between times. */
  doing: '' | 'checking' | 'downloading'
}>({ version: null, dismissed: false, last: null, doing: '' })

let listening = false
export function listenForUpdates() {
  if (listening || !window.alfredo) return
  listening = true
  window.alfredo.onUpdate((info) => {
    update.version = info.version
    update.dismissed = false
  })
  window.alfredo.onUpdateState?.((s) => {
    update.last = { ...update.last, ...s }
    update.doing = s.state === 'checking' || s.state === 'downloading' ? s.state : ''
  })
}
export const currentVersion = () => window.alfredo?.version ?? ''
export const checkForUpdates = () => window.alfredo?.checkForUpdate()
export const installUpdate = () => window.alfredo?.installUpdate()
