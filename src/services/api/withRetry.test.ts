import { APIError } from '@anthropic-ai/sdk'
import { describe, expect, test } from 'bun:test'
import { getRetryAfter, getRetryDelay } from './withRetry.js'

describe('retry-after handling', () => {
  test('uses the standard retry-after header first', () => {
    const error = new APIError(
      429,
      { 'retry-after': '36' },
      'rate limited',
      new Headers({ 'retry-after': '12' }),
    )

    expect(getRetryAfter(error)).toBe('12')
    expect(getRetryDelay(1, getRetryAfter(error))).toBe(12_000)
  })

  test('uses provider retry-after from structured API error bodies', () => {
    const providerBody = {
      type: 'error',
      error: {
        type: 'rate_limit_error',
        code: '1302',
        message: '[1302][Rate limit reached for requests][request-id]',
      },
      request_id: 'request-id',
      'retry-after': '36',
    }
    const error = new APIError(
      429,
      providerBody,
      JSON.stringify(providerBody),
      new Headers(),
    )

    expect(getRetryAfter(error)).toBe('36')
    expect(getRetryDelay(1, getRetryAfter(error))).toBe(36_000)
  })

  test('uses provider retry-after from stringified JSON messages', () => {
    const error = new Error(
      '429 {"type":"error","error":{"type":"rate_limit_error"},"retry-after":"36"}',
    )

    expect(getRetryAfter(error)).toBe('36')
    expect(getRetryDelay(1, getRetryAfter(error))).toBe(36_000)
  })
})
