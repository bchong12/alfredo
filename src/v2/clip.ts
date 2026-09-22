// Copying something out of Alfredo so an AI can use it.
//
// Pasting a card into a chat gives the model the words but not the thing: it
// cannot read the rest, and it cannot write back. So everything copied here
// carries a handle as well, naming the workspace and the exact MCP call that
// fetches it again. An assistant that has Alfredo connected can follow the
// handle; one that does not still has the text, which is what a person
// pasting expects anyway.

import { ui } from './state.svelte'
import { workspace } from '../lib/workspace.svelte'

export type Kind = 'card' | 'doc' | 'canvas' | 'meeting'

const LIST: Record<Kind, string> = { card: 'cards', doc: 'docs', canvas: 'canvases', meeting: 'meetings' }

const where = () => ({
  id: workspace.activeId,
  name: ui.settings?.name ?? workspace.list.find((w) => w.id === workspace.activeId)?.name ?? 'Workspace',
})

/**
 * Just the address: what it is, and the calls that read and change it. For an
 * assistant that has Alfredo connected this is all it needs, and better than
 * the words, since it reads the thing as it is now rather than as it was when
 * somebody copied it, and a long meeting is one line on the clipboard.
 */
export function linkForMcp(kind: Kind, id: string, title: string) {
  const ws = where()
  return [
    `Alfredo · ${ws.name} · ${kind} “${title}”`,
    `Read it:    ws_read kind:"${kind}" id:"${id}"   (MCP header x-workspace: ${ws.id})`,
    ...(kind === 'card' || kind === 'doc' ? [`Change it:  ws_write kind:"${kind}" id:"${id}"`] : []),
  ].join('\n')
}

/** One thing, with the call that reads it and the call that changes it. */
export function forClaude(kind: Kind, id: string, title: string, body: string) {
  const ws = where()
  return [
    `Alfredo · ${ws.name} · ${kind} “${title}”`,
    `Read it again:  ws_read kind:"${kind}" id:"${id}"   (MCP header x-workspace: ${ws.id})`,
    `Change it:      ws_write kind:"${kind}" id:"${id}"`,
    '',
    body.trim(),
  ].join('\n')
}

/** A set of things: a column, a cycle, everything on a canvas. */
export function manyForClaude(kind: Kind, what: string, bodies: string[], hint?: string) {
  const ws = where()
  return [
    `Alfredo · ${ws.name} · ${what}, ${bodies.length} ${bodies.length === 1 ? 'item' : 'items'}`,
    `List them:  ws_list kind:"${LIST[kind]}"${hint ? ` ${hint}` : ''}   (MCP header x-workspace: ${ws.id})`,
    '',
    bodies.map((b) => b.trim()).join('\n\n---\n\n'),
  ].join('\n')
}

/** The whole workspace, for a question rather than a paste. */
export function askHint(question = 'what was decided') {
  const ws = where()
  return `Alfredo · ${ws.name}\nAsk it yourself:  ask_workspace question:"${question}"   (MCP header x-workspace: ${ws.id})`
}
