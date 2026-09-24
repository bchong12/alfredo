// The Requests pack: bugs and ideas about a product, with votes and a status,
// from the team and from the people who use it. Kept as pack data
// "requests.<product>" (and "requests.settings" for which products exist).
import MessageSquarePlus from '@lucide/svelte/icons/message-square-plus'
import Requests from './Requests.svelte'
import type { PackTab } from '../index'

export const tabs: Record<string, PackTab> = {
  requests: { icon: MessageSquarePlus, component: Requests, views: [{ id: 'board', label: 'Requests' }] },
}
