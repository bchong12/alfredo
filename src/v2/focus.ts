/**
 * Put the cursor in a field the moment it appears.
 *
 * The `autofocus` attribute is unreliable for an element Svelte inserts after
 * the page has loaded: the browser has already chosen where focus lives, and
 * the attribute arrives too late to change its mind. A box that opens and then
 * ignores what you type is worse than no box, so this asks for focus itself,
 * a frame later, once the element is really in the page.
 */
export function takeFocus(el: HTMLInputElement | HTMLTextAreaElement, select = false) {
  requestAnimationFrame(() => {
    el.focus()
    if (select) el.select()
  })
}
