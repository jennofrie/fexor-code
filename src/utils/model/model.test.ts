import { describe, expect, test } from 'bun:test'
import {
  firstPartyNameToCanonical,
  modelRequiresDefaultSamplingParams,
} from './model.js'

describe('Claude Sonnet 5 model helpers', () => {
  test('canonicalizes Sonnet 5 model IDs', () => {
    expect(firstPartyNameToCanonical('claude-sonnet-5')).toBe(
      'claude-sonnet-5',
    )
  })

  test('marks Sonnet 5 as requiring default sampling parameters', () => {
    expect(modelRequiresDefaultSamplingParams('claude-sonnet-5')).toBe(true)
    expect(modelRequiresDefaultSamplingParams('claude-sonnet-4-6')).toBe(false)
  })
})
