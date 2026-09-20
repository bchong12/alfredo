/**
 * How many calls are in the air.
 *
 * The app draws one thin line at the top while anything is loading, so a slow
 * database looks busy rather than broken, and nothing else has to invent its
 * own spinner.
 */
export const net = $state({ busy: 0 })

export function counted<T>(run: () => Promise<T>): Promise<T> {
  net.busy++
  return run().finally(() => (net.busy = Math.max(0, net.busy - 1)))
}
