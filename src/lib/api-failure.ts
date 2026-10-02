/** HTTP metadata for callers that need quotas/fallbacks; message behavior is unchanged. */
export function apiFailure(response: Response, message: string, detail?: { code?: unknown } | null): Error & { status: number; retryAfter?: number; code?: string } {
  const raw = response.headers.get('Retry-After')
  const seconds = raw ? /^\d+$/.test(raw) ? Number(raw) : Math.ceil((Date.parse(raw) - Date.now()) / 1000) : NaN
  return Object.assign(new Error(message), { status: response.status,
    ...(response.status === 409 && detail?.code === 'resolution_terminal_no_write' ? { code: 'resolution_terminal_no_write' } : {}),
    retryAfter: Number.isFinite(seconds) && seconds > 0 ? seconds : undefined })
}
