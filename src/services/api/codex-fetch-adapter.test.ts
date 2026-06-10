import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createCodexFetch } from './codex-fetch-adapter.js'

const ENV_KEYS = [
  'CLAUDE_CODE_EFFORT_LEVEL',
  'CLAUDE_CODE_GPT_DEFAULT_EFFORT',
  'CLAUDE_CONFIG_DIR',
] as const

const savedEnv = new Map<string, string | undefined>()
let configDir: string | undefined

beforeEach(() => {
  savedEnv.clear()
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key])
    delete process.env[key]
  }
  configDir = mkdtempSync(join(tmpdir(), 'fexor-code-codex-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
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
  if (configDir) {
    rmSync(configDir, { recursive: true, force: true })
    configDir = undefined
  }
})

describe('Codex reasoning effort mapping', () => {
  test('defaults GPT-5.4 max reasoning to Codex xhigh', async () => {
    const captured = await captureCodexBody({
      model: 'gpt-5.4',
      messages: [{ role: 'user', content: 'audit this change' }],
    })

    expect(captured.reasoning).toEqual({ effort: 'xhigh' })
  })

  test('explicit high effort overrides the GPT max default', async () => {
    const captured = await captureCodexBody({
      model: 'gpt-5.4',
      output_config: { effort: 'high' },
      messages: [{ role: 'user', content: 'audit this change' }],
    })

    expect(captured.reasoning).toEqual({ effort: 'high' })
  })

  test('ultrathink promotes an explicit high turn to Codex xhigh', async () => {
    const captured = await captureCodexBody({
      model: 'gpt-5.4',
      output_config: { effort: 'high' },
      messages: [{ role: 'user', content: 'ultrathink about this change' }],
    })

    expect(captured.reasoning).toEqual({ effort: 'xhigh' })
  })

  test('falls back to high when a Codex GPT model lacks xhigh support', async () => {
    const captured = await captureCodexBody({
      model: 'gpt-5.1-codex',
      messages: [{ role: 'user', content: 'audit this change' }],
    })

    expect(captured.reasoning).toEqual({ effort: 'high' })
  })
})

describe('Codex auth handling', () => {
  test('rejects tokens missing required OpenAI scopes without outer retry', async () => {
    const codexFetch = createCodexFetch(fakeCodexToken([]), async () => {
      throw new Error('Codex backend should not be called')
    })

    const response = await codexFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        max_tokens: 1024,
        stream: false,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    expect(response.status).toBe(401)
    expect(response.headers.get('x-should-retry')).toBe('false')
    expect(await response.json()).toMatchObject({
      error: {
        type: 'authentication_error',
        message: expect.stringContaining('missing required OpenAI scopes'),
      },
    })
  })
})

describe('Codex stream error handling', () => {
  test('surfaces streaming response.failed instead of ending an empty turn', async () => {
    const codexFetch = createCodexFetch(fakeCodexToken(), async () => {
      return new Response(codexFailedSse('unsupported reasoning effort'), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    })

    const response = await codexFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-5.5',
        max_tokens: 1024,
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    const body = await response.text()
    expect(body).toContain('event: error')
    expect(body).toContain('unsupported reasoning effort')
    expect(body).not.toContain('event: message_stop')
  })

  test('surfaces non-streaming response.failed as an API error response', async () => {
    const codexFetch = createCodexFetch(fakeCodexToken(), async () => {
      return new Response(codexFailedSse('model is not available'), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    })

    const response = await codexFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-5.5',
        max_tokens: 1024,
        stream: false,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({
      error: {
        type: 'api_error',
        message: 'model is not available',
      },
    })
  })
})

async function captureCodexBody(
  anthropicBody: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> | undefined
  const codexFetch = createCodexFetch(fakeCodexToken(), async (_input, init) => {
    captured = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    return new Response(codexSse(), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  })

  const response = await codexFetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    body: JSON.stringify({
      max_tokens: 1024,
      stream: false,
      ...anthropicBody,
    }),
  })
  await response.text()

  if (!captured) {
    throw new Error('Codex request body was not captured')
  }
  return captured
}

function fakeCodexToken(
  scopes: string[] = ['openid', 'profile', 'email', 'offline_access'],
): string {
  const header = Buffer.from('{}').toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({
      scp: scopes,
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct_test',
      },
    }),
  ).toString('base64url')
  return `${header}.${payload}.signature`
}

function codexSse(): string {
  return [
    'event: response.output_item.done',
    'data: {"type":"response.output_item.done","item":{"type":"message","content":[{"type":"output_text","text":"ok"}]}}',
    '',
    'event: response.completed',
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}',
    '',
    '',
  ].join('\n')
}

function codexFailedSse(message: string): string {
  return [
    'event: response.failed',
    `data: {"type":"response.failed","response":{"error":{"message":${JSON.stringify(message)}}}}`,
    '',
    '',
  ].join('\n')
}
