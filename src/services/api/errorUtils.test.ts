import { APIError } from '@anthropic-ai/sdk'
import { describe, expect, test } from 'bun:test'
import { formatAPIError } from './errorUtils.js'

describe('formatAPIError', () => {
  test('sanitizes provider request-rate limit payloads', () => {
    const providerBody = {
      type: 'error',
      error: {
        type: 'rate_limit_error',
        code: '1302',
        message: '[1302][Rate limit reached for requests][request-id]',
      },
      request_id: 'request-id',
      'retry-after': '3',
    }
    const error = new APIError(
      429,
      providerBody,
      JSON.stringify(providerBody),
      new Headers(),
    )

    expect(formatAPIError(error)).toBe('Provider request rate limit reached.')
  })
})
