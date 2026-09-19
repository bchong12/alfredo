// The board is scoped to a week, so both the REST API and the MCP tools need
// the same answer to "which week is it". Keeping that in one place is the
// point of this module.

import { db, many } from './db'

export type Week = { id: string; number: number; starts_on: string; label: string | null }

/**
 * Local date rather than the database's. Postgres runs in UTC and rolls over
 * hours before the machine does, which is enough to put "today" in the wrong
 * week for most of an evening.
 */
export function localToday() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`
}

export function endsOn(week: Week) {
  const d = new Date(`${week.starts_on}T00:00:00`)
  d.setDate(d.getDate() + 6)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`
}

export function listWeeks() {
  return many<Week>(db.from('weeks').select('*').order('number'))
}

/** The week containing today, or the last one if the calendar has run out. */
export async function currentWeek(): Promise<Week | null> {
  const weeks = await listWeeks()
  if (!weeks.length) return null
  const today = localToday()
  return weeks.find((w) => w.starts_on <= today && today <= endsOn(w)) ?? weeks[weeks.length - 1]
}

/** Resolve a week number to a row. `null` means the backlog, deliberately. */
export async function weekByNumber(n: number | null | undefined): Promise<Week | null> {
  if (n == null) return null
  const weeks = await listWeeks()
  const w = weeks.find((x) => x.number === n)
  if (!w) throw new Error(`no week ${n}; the calendar runs 1 to ${weeks.length}`)
  return w
}
