import test from 'node:test'
import assert from 'node:assert/strict'
import { apiFailure } from './api-failure'
test('only the terminal no-write code on 409 survives client error conversion', () => {
  assert.equal(apiFailure(new Response(null, { status: 409 }), 'failed', { code: 'resolution_terminal_no_write' }).code, 'resolution_terminal_no_write')
  for (const status of [403, 502]) assert.equal(apiFailure(new Response(null, { status }), 'failed', { code: 'resolution_terminal_no_write' }).code, undefined)
  assert.equal(apiFailure(new Response(null, { status: 409 }), 'failed', { code: 'nonce_conflict' }).code, undefined)
})
test('HTTP failures retain status and numeric cooldown without consuming/echoing response body', async () => {
  const response = new Response('synthetic private upstream detail', { status: 429, headers: { 'Retry-After': '75' } })
  const error = apiFailure(response, 'Request failed')
  assert.equal(error.status, 429)
  assert.equal(error.retryAfter, 75)
  assert.equal(error.message, 'Request failed')
  assert.equal(response.bodyUsed, false)
  assert.equal(JSON.stringify(error).includes('private'), false)
})
test('date cooldown is bounded and malformed/expired values are absent', () => {
  const future = new Date(Date.now() + 60_000).toUTCString()
  assert.ok((apiFailure(new Response(null, { status: 429, headers: { 'Retry-After': future } }), 'failed').retryAfter ?? 0) > 58)
  for (const value of ['garbage', '-3', '0', 'Tue, 01 Jan 2000 00:00:00 GMT'])
    assert.equal(apiFailure(new Response(null, { status: 503, headers: { 'Retry-After': value } }), 'failed').retryAfter, undefined)
})
