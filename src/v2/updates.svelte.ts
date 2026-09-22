// A newer Alfredo, downloaded by the shell and waiting: the page says so once
// and offers the restart. Only the desktop app has a shell to hear from.
declare global {
  interface Window {
    alfredo?: {
      onUpdate: (cb: (info: { version: string }) => void) => void
      installUpdate: () => void
      checkForUpdate: () => Promise<{ version?: string | null; error?: string }>
      version: string
    }
  }
}

export const update = $state<{ version: string | null; dismissed: boolean }>({ version: null, dismissed: false })

let listening = false
export function listenForUpdates() {
  if (listening || !window.alfredo) return
  listening = true
  window.alfredo.onUpdate((info) => {
    update.version = info.version
    update.dismissed = false
  })
}
export const installUpdate = () => window.alfredo?.installUpdate()
