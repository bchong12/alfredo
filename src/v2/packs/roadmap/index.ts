// The Roadmap pack: a plan as an order of steps, who owns each, and the
// decisions in the way. Kept in the workspace's own pack data under
// "roadmap.main", so it works on every kind of database and an agent reads and
// writes it with get_pack_data / set_pack_data.
import Milestone from '@lucide/svelte/icons/milestone'
import Roadmap from './Roadmap.svelte'
import type { PackTab } from '../index'

export const tabs: Record<string, PackTab> = {
  roadmap: { icon: Milestone, component: Roadmap, views: [{ id: 'order', label: 'Roadmap' }] },
}
