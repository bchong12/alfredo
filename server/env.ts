// One way to read configuration on both runtimes. Node has process.env; the
// Supabase Edge Runtime has Deno.env. Reading the wrong one fails at boot with
// a message that points at the missing key rather than at the runtime, which
// is a bad half hour to spend.
declare const Deno: { env: { get(k: string): string | undefined } } | undefined

export function env(key: string): string | undefined {
  if (typeof Deno !== 'undefined' && Deno?.env) return Deno.env.get(key)
  return typeof process !== 'undefined' ? process.env[key] : undefined
}

export function required(key: string): string {
  const v = env(key)
  if (!v) throw new Error(`${key} is not set`)
  return v
}
