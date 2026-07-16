import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  GPT_5_4_CONTEXT_WINDOW,
  MODEL_CONTEXT_WINDOW_DEFAULT,
  getContextWindowForModel,
  getModelMaxOutputTokens,
} from './context.js'

const ENV_KEYS = [
  'CLAUDE_CODE_DISABLE_1M_CONTEXT',
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
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

describe('Claude Sonnet context windows', () => {
  test('uses native 1M context for Sonnet 5 without a suffix', () => {
    expect(getContextWindowForModel('claude-sonnet-5')).toBe(1_000_000)
  })

  test('keeps sonnet[1m] compatible for gateway-style model settings', () => {
    expect(getContextWindowForModel('claude-sonnet-5[1m]')).toBe(1_000_000)
  })

  test('caps Sonnet 5 to the default window when 1M context is disabled', () => {
    process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = '1'
    expect(getContextWindowForModel('claude-sonnet-5')).toBe(
      MODEL_CONTEXT_WINDOW_DEFAULT,
    )
  })

  test('uses 128K max output for Sonnet 5', () => {
    expect(getModelMaxOutputTokens('claude-sonnet-5')).toEqual({
      default: 32_000,
      upperLimit: 128_000,
    })
  })
})

describe('OpenAI GPT context windows', () => {
  test('uses the documented 1.05M context window for GPT-5.4', () => {
    expect(getContextWindowForModel('gpt-5.4')).toBe(GPT_5_4_CONTEXT_WINDOW)
  })

  test('does not apply GPT-5.4 long context to GPT-5.4 Mini', () => {
    expect(getContextWindowForModel('gpt-5.4-mini')).toBe(
      MODEL_CONTEXT_WINDOW_DEFAULT,
    )
  })
})

describe('GLM context and output windows', () => {
  test('uses 1M context and 128K output for GLM-5.2 1M launch model', () => {
    expect(getContextWindowForModel('glm-5.2[1m]')).toBe(1_000_000)
    expect(getModelMaxOutputTokens('glm-5.2[1m]')).toEqual({
      default: 64_000,
      upperLimit: 128_000,
    })
  })
})
