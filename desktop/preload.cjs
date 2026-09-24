// The one door between the page and the shell: an update that has arrived,
// and the button that installs it. Nothing else of Electron reaches the page.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('alfredo', {
  /** Called with { version } once a newer Alfredo has been downloaded. */
  onUpdate: (cb) => ipcRenderer.on('update-ready', (_e, info) => cb(info)),
  /** Every step: checking, latest, downloading (percent), ready, error. */
  onUpdateState: (cb) => ipcRenderer.on('update-state', (_e, s) => cb(s)),
  /** Quit, install it, and come back. */
  installUpdate: () => ipcRenderer.send('install-update'),
  /** Look now rather than on the clock; answers { version } or { error }. */
  checkForUpdate: () => ipcRenderer.invoke('check-update'),
  version: (process.argv.find((a) => a.startsWith('--alfredo-version=')) ?? '').split('=')[1] ?? '',
  /** A system notification. `action` is the one button it offers, if any. */
  notify: (n) => ipcRenderer.send('notify', n),
  /** Called with { id, action } when a notification's button, or its body, was pressed. */
  onNotificationAction: (cb) => ipcRenderer.on('notify-action', (_e, r) => cb(r)),
})
