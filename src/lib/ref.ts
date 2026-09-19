// Card reference ids, PUR-12. Shared by the browser and the server so the two
// can never disagree about what a ref means.
//
// The prefix is the workspace's, not a stored column: storing it would mean
// migrating every row just to rename the workspace. The server sets it per
// request from the workspace; the browser sets it when the workspace changes.

// A string in the browser; on the server a function that reads the prefix off
// the current request, so two workspaces served at once cannot cross over.
let prefix: string | (() => string) = 'PUR'

export const REF_PREFIX = () => (typeof prefix === 'function' ? prefix() : prefix)
export function setRefPrefix(p: string | (() => string)) {
  prefix = p
}

/** Three letters of the name, e.g. Acme → ACM. */
export const prefixFor = (name: string) => {
  const letters = name.replace(/[^A-Za-z]/g, '').toUpperCase()
  return (letters.slice(0, 3) || 'WRK').padEnd(3, 'X')
}

export const formatRef = (n: number, p = REF_PREFIX()) => `${p}-${n}`

/** Returns the number for a well-formed ref, else null. Any prefix is
 *  accepted: a ref pasted from another workspace still names a number. */
export function parseRef(s: string): number | null {
  const m = /^([A-Za-z]+)-(\d+)$/.exec(s.trim())
  if (!m) return null
  return Number(m[2])
}
