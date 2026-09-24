// Release notes arrive as GitHub's HTML. Only the harmless of it reaches the
// page: text, structure, links to https, nothing that runs or styles.
const KEEP = new Set(['P', 'BR', 'STRONG', 'B', 'EM', 'I', 'CODE', 'PRE', 'UL', 'OL', 'LI', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'H1', 'H2', 'H3', 'H4', 'A', 'BLOCKQUOTE', 'HR'])

export function tidyHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const walk = (node: Element) => {
    for (const child of Array.from(node.children)) {
      if (!KEEP.has(child.tagName)) {
        child.replaceWith(...Array.from(child.childNodes))
        continue
      }
      for (const a of Array.from(child.attributes)) {
        if (child.tagName === 'A' && a.name === 'href' && /^https:\/\//.test(a.value)) continue
        child.removeAttribute(a.name)
      }
      if (child.tagName === 'A') {
        child.setAttribute('target', '_blank')
        child.setAttribute('rel', 'noreferrer')
      }
      walk(child)
    }
  }
  walk(doc.body)
  return doc.body.innerHTML
}
