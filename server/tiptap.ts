// Tiptap/ProseMirror JSON <-> Markdown.
//
// Cloudflare workspaces store documents and meeting notes as Tiptap JSON
// (that is what a Worker-backed workspace's editor writes). Alfredo's editor speaks
// Markdown. Both directions cover what those documents actually contain:
// headings, paragraphs, bold/italic/code/links, bullet, numbered and task
// lists, quotes, code blocks, rules and images. Anything else is kept as its
// plain text rather than dropped.

import { marked, type Token, type Tokens } from 'marked'

type PMNode = {
  type: string
  attrs?: Record<string, any>
  content?: PMNode[]
  text?: string
  marks?: { type: string; attrs?: Record<string, any> }[]
}

// --- Tiptap -> Markdown -----------------------------------------------------

function inline(nodes: PMNode[] = []): string {
  return nodes
    .map((n) => {
      if (n.type === 'hardBreak') return '  \n'
      if (n.type === 'image') return `![${n.attrs?.alt ?? ''}](${n.attrs?.src ?? ''})`
      let t = n.text ?? inline(n.content)
      for (const m of n.marks ?? []) {
        if (m.type === 'bold' || m.type === 'strong') t = `**${t}**`
        else if (m.type === 'italic' || m.type === 'em') t = `*${t}*`
        else if (m.type === 'code') t = '`' + t + '`'
        else if (m.type === 'strike') t = `~~${t}~~`
        else if (m.type === 'link') t = `[${t}](${m.attrs?.href ?? ''})`
      }
      return t
    })
    .join('')
}

function block(n: PMNode, indent = ''): string {
  switch (n.type) {
    case 'heading':
      return `${'#'.repeat(n.attrs?.level ?? 1)} ${inline(n.content)}`
    case 'paragraph':
      return indent + inline(n.content)
    case 'blockquote':
      return (n.content ?? []).map((c) => block(c)).join('\n\n').split('\n').map((l) => `> ${l}`).join('\n')
    case 'codeBlock':
      return '```' + (n.attrs?.language ?? '') + '\n' + inline(n.content) + '\n```'
    case 'horizontalRule':
      return '---'
    case 'image':
      return `![${n.attrs?.alt ?? ''}](${n.attrs?.src ?? ''})`
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return (n.content ?? [])
        .map((item, i) => {
          const mark =
            n.type === 'orderedList' ? `${(n.attrs?.start ?? 1) + i}.` : n.type === 'taskList' ? `- [${item.attrs?.checked ? 'x' : ' '}]` : '-'
          const [first, ...rest] = item.content ?? []
          const head = `${indent}${mark} ${first ? inline(first.content) : ''}`
          const tail = rest.map((c) => block(c, indent + '  ')).join('\n')
          return tail ? `${head}\n${tail}` : head
        })
        .join('\n')
    default:
      return n.content ? n.content.map((c) => block(c, indent)).join('\n\n') : (n.text ?? '')
  }
}

export function tiptapToMarkdown(doc: PMNode | null | undefined): string {
  if (!doc) return ''
  return (doc.content ?? []).map((n) => block(n)).join('\n\n').trim() + '\n'
}

// --- Markdown -> Tiptap -----------------------------------------------------

function inlineTokens(tokens: Token[] = [], marks: PMNode['marks'] = []): PMNode[] {
  const out: PMNode[] = []
  for (const t of tokens) {
    switch (t.type) {
      case 'text':
      case 'escape': {
        const tt = t as Tokens.Text
        if (tt.tokens?.length) out.push(...inlineTokens(tt.tokens, marks))
        else if (tt.text) out.push({ type: 'text', text: tt.text, ...(marks.length ? { marks } : {}) })
        break
      }
      case 'strong':
        out.push(...inlineTokens((t as Tokens.Strong).tokens, [...marks, { type: 'bold' }]))
        break
      case 'em':
        out.push(...inlineTokens((t as Tokens.Em).tokens, [...marks, { type: 'italic' }]))
        break
      case 'del':
        out.push(...inlineTokens((t as Tokens.Del).tokens, [...marks, { type: 'strike' }]))
        break
      case 'codespan':
        out.push({ type: 'text', text: (t as Tokens.Codespan).text, marks: [...marks, { type: 'code' }] })
        break
      case 'link':
        out.push(...inlineTokens((t as Tokens.Link).tokens, [...marks, { type: 'link', attrs: { href: (t as Tokens.Link).href } }]))
        break
      case 'image':
        out.push({ type: 'image', attrs: { src: (t as Tokens.Image).href, alt: (t as Tokens.Image).text } })
        break
      case 'br':
        out.push({ type: 'hardBreak' })
        break
      default:
        if ('text' in t && (t as any).text) out.push({ type: 'text', text: (t as any).text })
    }
  }
  return out.filter((n) => n.type !== 'text' || n.text)
}

function blockTokens(tokens: Token[]): PMNode[] {
  const out: PMNode[] = []
  for (const t of tokens) {
    switch (t.type) {
      case 'heading':
        out.push({ type: 'heading', attrs: { level: (t as Tokens.Heading).depth }, content: inlineTokens((t as Tokens.Heading).tokens) })
        break
      case 'paragraph': {
        const content = inlineTokens((t as Tokens.Paragraph).tokens)
        // A paragraph that is only an image becomes the image block itself.
        if (content.length === 1 && content[0].type === 'image') out.push(content[0])
        else out.push({ type: 'paragraph', content })
        break
      }
      case 'blockquote':
        out.push({ type: 'blockquote', content: blockTokens((t as Tokens.Blockquote).tokens) })
        break
      case 'code':
        out.push({ type: 'codeBlock', attrs: { language: (t as Tokens.Code).lang || null }, content: [{ type: 'text', text: (t as Tokens.Code).text }] })
        break
      case 'hr':
        out.push({ type: 'horizontalRule' })
        break
      case 'list': {
        const l = t as Tokens.List
        const task = l.items.some((i) => i.task)
        out.push({
          type: task ? 'taskList' : l.ordered ? 'orderedList' : 'bulletList',
          ...(l.ordered && !task ? { attrs: { start: Number(l.start) || 1 } } : {}),
          content: l.items.map((i) => {
            const inner = blockTokens(i.tokens.filter((x) => x.type !== 'checkbox'))
            const content = inner.length ? inner.map((n) => (n.type === 'text' ? { type: 'paragraph', content: [n] } : n)) : [{ type: 'paragraph' }]
            return task
              ? { type: 'taskItem', attrs: { checked: !!i.checked }, content }
              : { type: 'listItem', content }
          }),
        })
        break
      }
      case 'text': {
        // Loose text inside list items arrives as a text token with inline children.
        const tt = t as Tokens.Text
        out.push({ type: 'paragraph', content: inlineTokens(tt.tokens ?? [{ type: 'text', raw: tt.text, text: tt.text } as Token]) })
        break
      }
      case 'space':
        break
      default:
        if ((t as any).text) out.push({ type: 'paragraph', content: [{ type: 'text', text: (t as any).text }] })
    }
  }
  return out
}

export function markdownToTiptap(md: string): PMNode {
  const content = blockTokens(marked.lexer(md ?? ''))
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] }
}
