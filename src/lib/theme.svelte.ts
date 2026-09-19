// Dark or light. Nothing else changes between them but the greys, so the
// choice is one attribute on <html> and the tokens in app.css do the rest.

export type Theme = 'dark' | 'light' | 'system'
const KEY = 'alfred.theme'

export const theme = $state({ mode: 'system' as Theme })

function stored(): Theme {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'dark' || v === 'light' ? v : 'system'
  } catch {
    return 'system'
  }
}

export function applyTheme(mode: Theme = stored()) {
  theme.mode = mode
  const root = document.documentElement
  if (mode === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', mode)
  try {
    if (mode === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, mode)
  } catch {}
}

/** What is actually on screen right now, resolving 'system'. */
export function effectiveTheme(): 'dark' | 'light' {
  if (theme.mode !== 'system') return theme.mode
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

export function toggleTheme() {
  applyTheme(effectiveTheme() === 'dark' ? 'light' : 'dark')
}
