import { describe, expect, test } from 'bun:test'
import {
  GPT_5_4_CONTEXT_WINDOW,
  MODEL_CONTEXT_WINDOW_DEFAULT,
  getContextWindowForModel,
} from './context.js'

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
