// node-pty, loaded when first needed rather than when the server starts.
//
// It is a native module built for one Node ABI. Where it does not load (a
// Windows build whose rebuild did not take, a machine missing a runtime
// library), the whole server used to die at import and the app opened on a
// blank page with nothing to say. Now the server comes up; terminals and the
// Composio CLI say what is wrong when they are asked for.
import { createRequire as makeRequire } from 'node:module'

type Pty = typeof import('node-pty')
let loaded: Pty | null = null
let failed: Error | null = null

export function pty(): Pty {
  if (loaded) return loaded
  if (failed) throw failed
  try {
    loaded = makeRequire(import.meta.url)('node-pty') as Pty
    return loaded
  } catch (e) {
    failed = new Error(`Terminals are not available on this machine: node-pty did not load (${(e as Error).message.split('\n')[0]}).`)
    throw failed
  }
}
export const ptyAvailable = () => {
  try {
    pty()
    return true
  } catch {
    return false
  }
}
