// The one door between the page and the shell: an update that has arrived,
// and the button that installs it. Nothing else of Electron reaches the page.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('alfredo', {
  /** Called with { version } once a newer Alfredo has been downloaded. */
  onUpdate: (cb) => ipcRenderer.on('update-ready', (_e, info) => cb(info)),
  /** Quit, install it, and come back. */
  installUpdate: () => ipcRenderer.send('install-update'),
  /** Look now rather than on the clock; answers { version } or { error }. */
  checkForUpdate: () => ipcRenderer.invoke('check-update'),
  version: process.env.ALFREDO_VERSION ?? '',
})
