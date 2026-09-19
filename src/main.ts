import { mount } from 'svelte'
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import { applyTheme } from './lib/theme.svelte'
import { setKeyboardDragTrigger } from 'svelte-dnd-action'
import V2App from './v2/V2App.svelte'
import './app.css'

/* svelte-dnd-action binds Space AND Enter globally to start a keyboard drag.
   Board cards use Enter to open their detail, so Enter was double-bound.
   Space alone frees it. Escape stays reserved by the library during a drag. */
setKeyboardDragTrigger('space')
applyTheme()
// Inside the Mac app the window has no title bar; leave room for the traffic lights.
if (navigator.userAgent.includes('Electron')) document.documentElement.classList.add('desktop')

export default mount(V2App, { target: document.getElementById('app')! })
