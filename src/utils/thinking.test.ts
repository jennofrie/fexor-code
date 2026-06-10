import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  modelSupportsAdaptiveThinking,
  modelSupportsThinking,
} from './thinking.js'

const ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_VERTEX',
  'USER_TYPE',
] as const

const savedEnv = new Map<string, string | undefined>()

beforeEach(() => {
  savedEnv.clear()
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key])
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key)
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
})

describe('Claude thinking support', () => {
  test('supports budgeted thinking, not adaptive thinking, for Opus 4.5', () => {
    const model = 'claude-opus-4-5-20251101'
    expect(modelSupportsThinking(model)).toBe(true)
    expect(modelSupportsAdaptiveThinking(model)).toBe(false)
  })

  test('supports adaptive thinking for Sonnet 4.6', () => {
    expect(modelSupportsAdaptiveThinking('claude-sonnet-4-6')).toBe(true)
  })
})
