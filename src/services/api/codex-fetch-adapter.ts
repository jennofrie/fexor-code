/**
 * Codex Fetch Adapter
 *
 * Intercepts Anthropic SDK Messages API calls in OpenAI/Codex mode and routes
 * them to ChatGPT's Codex Responses backend. This file is intentionally scoped
 * to GPT/Codex models so Anthropic-compatible providers such as GLM, Claude,
 * and Deepseek keep using their normal request path.
 */

import {
  getCodexOAuthTokens,
  saveCodexOAuthTokens,
} from '../../utils/auth.js'
import { isOAuthTokenExpired } from '../oauth/client.js'
import {
  hasCodexScope,
  refreshCodexToken,
} from '../oauth/codex-client.js'

// ── Available Codex models ──────────────────────────────────────────

export const CODEX_MODELS = [
  { id: 'gpt-5.5', label: 'GPT-5.5', description: 'Latest flagship model' },
  {
    id: 'gpt-5.4',
    label: 'GPT-5.4',
    description: '1.05M context GPT model',
  },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', description: 'Fast GPT model' },
  {
    id: 'gpt-5.3-codex',
    label: 'GPT-5.3 Codex',
    description: 'Codex coding model',
  },
  {
    id: 'gpt-5.2-codex',
    label: 'GPT-5.2 Codex',
    description: 'Frontier agentic coding model',
  },
  { id: 'gpt-5.2', label: 'GPT-5.2', description: 'GPT-5.2' },
  {
    id: 'gpt-5.1-codex',
    label: 'GPT-5.1 Codex',
    description: 'Codex coding model',
  },
  {
    id: 'gpt-5.1-codex-mini',
    label: 'GPT-5.1 Codex Mini',
    description: 'Fast Codex model',
  },
  {
    id: 'gpt-5.1-codex-max',
    label: 'GPT-5.1 Codex Max',
    description: 'Max Codex model',
  },
] as const

export const DEFAULT_CODEX_MODEL = 'gpt-5.5'

const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex/responses'
const JWT_CLAIM_PATH = 'https://api.openai.com/auth'

export const SAKANA_MODELS = [
  { id: 'fugu', label: 'Fugu', description: 'Sakana Fugu' },
  {
    id: 'fugu-ultra',
    label: 'Fugu Ultra',
    description: 'Sakana Fugu Ultra',
  },
  {
    id: 'fugu-ultra-20260615',
    label: 'Fugu Ultra 20260615',
    description: 'Pinned Sakana Fugu Ultra snapshot',
  },
] as const

export const DEFAULT_SAKANA_MODEL = 'fugu'

const DEFAULT_SAKANA_BASE_URL = 'https://api.sakana.ai/v1/responses'

let pendingCodexRefresh:
  | Promise<{ accessToken: string; accountId: string }>
  | null = null

// ── Types ───────────────────────────────────────────────────────────

interface AnthropicContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string | AnthropicContentBlock[]
  source?: {
    type?: string
    media_type?: string
    data?: string
  }
  [key: string]: unknown
}

interface AnthropicMessage {
  role: string
  content: string | AnthropicContentBlock[]
}

interface AnthropicTool {
  name: string
  description?: string
  input_schema?: Record<string, unknown>
}

type RequestedReasoningEffort = 'low' | 'medium' | 'high' | 'max' | 'xhigh'
type CodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh'
type CodexVerbosity = 'low' | 'medium' | 'high'
type ResponsesBackend = 'codex' | 'sakana'

type ResponsesFetchOptions = {
  backend: ResponsesBackend
  accessToken?: string
  apiKey?: string
  baseFetch: typeof globalThis.fetch
  baseUrl?: string
}

type ToolBlockState = {
  index: number
  itemId: string
  callId: string
  name: string
  args: string
  hasArgumentDeltas: boolean
  closed: boolean
}

// ── Model helpers ───────────────────────────────────────────────────

/**
 * Maps Claude model names to corresponding Codex model names.
 */
export function mapClaudeModelToCodex(claudeModel: string | null): string {
  if (!claudeModel) return DEFAULT_CODEX_MODEL
  if (isCodexModel(claudeModel)) return claudeModel
  const lower = claudeModel.toLowerCase()
  if (lower.includes('opus')) return 'gpt-5.5'
  if (lower.includes('haiku')) return 'gpt-5.1-codex-mini'
  if (lower.includes('sonnet')) return 'gpt-5.5'
  return DEFAULT_CODEX_MODEL
}

export function isCodexModel(model: string): boolean {
  return CODEX_MODELS.some(m => m.id === model)
}

export function isSakanaModel(model: string): boolean {
  const normalized = model.toLowerCase()
  return (
    SAKANA_MODELS.some(m => m.id === normalized) ||
    /^fugu(?:-|$)/.test(normalized)
  )
}

export function mapClaudeModelToSakana(claudeModel: string | null): string {
  if (!claudeModel) return DEFAULT_SAKANA_MODEL
  if (isSakanaModel(claudeModel)) return claudeModel
  const lower = claudeModel.toLowerCase()
  if (lower.includes('opus') || lower.includes('ultra')) return 'fugu-ultra'
  return DEFAULT_SAKANA_MODEL
}

function mapClaudeModelToResponses(
  claudeModel: string | null,
  backend: ResponsesBackend,
): string {
  return backend === 'sakana'
    ? mapClaudeModelToSakana(claudeModel)
    : mapClaudeModelToCodex(claudeModel)
}

function codexModelSupportsReasoning(modelId: string): boolean {
  return modelId.startsWith('gpt-5')
}

function responsesModelSupportsReasoning(
  modelId: string,
  backend: ResponsesBackend,
): boolean {
  return backend === 'sakana'
    ? isSakanaModel(modelId)
    : codexModelSupportsReasoning(modelId)
}

function codexModelSupportsExtraHighReasoning(modelId: string): boolean {
  return (
    modelId === 'gpt-5.1-codex-max' ||
    /^gpt-5\.(?:2|3|4|5)/.test(modelId)
  )
}

// ── Auth helpers ────────────────────────────────────────────────────

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const [, payload] = token.split('.')
    if (!payload) return null
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as
      | Record<string, unknown>
      | null
  } catch {
    return null
  }
}

function extractAccountId(token: string): string {
  const payload = decodeJwtPayload(token)
  const authClaim = payload?.[JWT_CLAIM_PATH]
  const accountId =
    authClaim && typeof authClaim === 'object'
      ? (authClaim as Record<string, unknown>).chatgpt_account_id
      : null
  if (typeof accountId !== 'string' || accountId.length === 0) {
    throw new Error('Failed to extract account ID from Codex token')
  }
  return accountId
}

function readCodexOAuthTokens() {
  try {
    return getCodexOAuthTokens()
  } catch {
    return null
  }
}

async function resolveCodexAuth(
  fallbackAccessToken: string,
): Promise<{ accessToken: string; accountId: string }> {
  const tokens = readCodexOAuthTokens()
  if (!tokens) {
    if (!hasCodexScope(fallbackAccessToken)) {
      throw new Error(
        'Codex OAuth token is missing required OpenAI scopes. Please run /login again and choose OpenAI Codex account.',
      )
    }
    return {
      accessToken: fallbackAccessToken,
      accountId: extractAccountId(fallbackAccessToken),
    }
  }

  if (!hasCodexScope(tokens.accessToken)) {
    throw new Error(
      'Codex OAuth token is missing required OpenAI scopes. Please run /login again and choose OpenAI Codex account.',
    )
  }

  if (isOAuthTokenExpired(tokens.expiresAt)) {
    const refreshed = await refreshCodexToken(tokens.refreshToken)
    saveCodexOAuthTokens(refreshed)
    return {
      accessToken: refreshed.accessToken,
      accountId: refreshed.accountId,
    }
  }

  return {
    accessToken: tokens.accessToken,
    accountId: tokens.accountId,
  }
}

async function forceRefreshCodexAuth(): Promise<{
  accessToken: string
  accountId: string
}> {
  if (pendingCodexRefresh) return pendingCodexRefresh

  pendingCodexRefresh = (async () => {
    const tokens = readCodexOAuthTokens()
    if (!tokens?.refreshToken) {
      throw new Error('Codex token expired. Please run /login again.')
    }
    const refreshed = await refreshCodexToken(tokens.refreshToken)
    saveCodexOAuthTokens(refreshed)
    return {
      accessToken: refreshed.accessToken,
      accountId: refreshed.accountId,
    }
  })().finally(() => {
    pendingCodexRefresh = null
  })

  return pendingCodexRefresh
}

// ── Reasoning and verbosity ─────────────────────────────────────────

const EFFORT_PATTERN =
  /reasoning effort level:\s*(low|medium|high|max|xhigh|extra[-\s]?high)/i
const ULTRATHINK_PATTERN = /\bultrathink\b/i
const DEFAULT_GPT_REASONING_EFFORT: RequestedReasoningEffort = 'max'
const DEFAULT_SAKANA_REASONING_EFFORT: RequestedReasoningEffort = 'high'
const GPT_DEFAULT_EFFORT_ENV = 'CLAUDE_CODE_GPT_DEFAULT_EFFORT'
const SAKANA_DEFAULT_EFFORT_ENV = 'CLAUDE_CODE_SAKANA_DEFAULT_EFFORT'

function normalizeEffort(value: string): RequestedReasoningEffort | null {
  const level = value.toLowerCase().replace(/\s+/g, '-')
  if (level === 'extra-high') return 'xhigh'
  if (
    level === 'low' ||
    level === 'medium' ||
    level === 'high' ||
    level === 'max' ||
    level === 'xhigh'
  ) {
    return level
  }
  return null
}

function checkEffortText(text: string): RequestedReasoningEffort | null {
  const match = EFFORT_PATTERN.exec(text)
  return match ? normalizeEffort(match[1]!) : null
}

function effortFromEnv(): RequestedReasoningEffort | null | undefined {
  const raw = process.env.CLAUDE_CODE_EFFORT_LEVEL
  if (!raw) return undefined
  const normalized = raw.toLowerCase()
  if (normalized === 'unset' || normalized === 'auto' || normalized === 'none') {
    return null
  }
  return normalizeEffort(raw)
}

function defaultGptEffortFromEnv(): RequestedReasoningEffort | null {
  const raw = process.env[GPT_DEFAULT_EFFORT_ENV]
  if (!raw) return DEFAULT_GPT_REASONING_EFFORT
  const normalized = raw.toLowerCase()
  if (normalized === 'unset' || normalized === 'auto' || normalized === 'none') {
    return null
  }
  return normalizeEffort(raw) ?? DEFAULT_GPT_REASONING_EFFORT
}

function defaultReasoningEffortFromEnv(
  backend: ResponsesBackend,
): RequestedReasoningEffort | null {
  if (backend === 'codex') return defaultGptEffortFromEnv()

  const raw =
    process.env[SAKANA_DEFAULT_EFFORT_ENV] ?? process.env[GPT_DEFAULT_EFFORT_ENV]
  if (!raw) return DEFAULT_SAKANA_REASONING_EFFORT
  const normalized = raw.toLowerCase()
  if (normalized === 'unset' || normalized === 'auto' || normalized === 'none') {
    return null
  }
  return normalizeEffort(raw) ?? DEFAULT_SAKANA_REASONING_EFFORT
}

function extractReasoningEffort(
  messages: AnthropicMessage[],
  instructions: string,
  outputConfig?: Record<string, unknown>,
  backend: ResponsesBackend = 'codex',
): { effort: RequestedReasoningEffort; fromUltrathink: boolean } | null {
  const fromInstructions = checkEffortText(instructions)
  if (fromInstructions) {
    return {
      effort: fromInstructions,
      fromUltrathink: ULTRATHINK_PATTERN.test(instructions),
    }
  }
  if (ULTRATHINK_PATTERN.test(instructions)) {
    return { effort: 'max', fromUltrathink: true }
  }

  for (const msg of messages) {
    const blocks =
      typeof msg.content === 'string'
        ? [{ type: 'text', text: msg.content }]
        : msg.content

    for (const block of blocks) {
      if (block.type !== 'text' || typeof block.text !== 'string') continue
      const effort = checkEffortText(block.text)
      if (effort) {
        return {
          effort,
          fromUltrathink: ULTRATHINK_PATTERN.test(block.text),
        }
      }
      if (ULTRATHINK_PATTERN.test(block.text)) {
        return { effort: 'max', fromUltrathink: true }
      }
    }
  }

  const configuredEffort = outputConfig?.effort
  if (typeof configuredEffort === 'string') {
    const effort = normalizeEffort(configuredEffort)
    if (effort) return { effort, fromUltrathink: false }
  }

  const envEffort = effortFromEnv()
  if (envEffort !== undefined) {
    return envEffort ? { effort: envEffort, fromUltrathink: false } : null
  }

  const defaultEffort = defaultReasoningEffortFromEnv(backend)
  return defaultEffort ? { effort: defaultEffort, fromUltrathink: false } : null
}

function mapReasoningEffortForCodex(
  requested: { effort: RequestedReasoningEffort; fromUltrathink: boolean },
  modelId: string,
): CodexReasoningEffort {
  if (
    requested.effort === 'xhigh' ||
    requested.effort === 'max' ||
    (requested.fromUltrathink && requested.effort === 'high')
  ) {
    return codexModelSupportsExtraHighReasoning(modelId) ? 'xhigh' : 'high'
  }
  return requested.effort
}

function mapReasoningEffortForResponses(
  requested: { effort: RequestedReasoningEffort; fromUltrathink: boolean },
  modelId: string,
  backend: ResponsesBackend,
): string {
  if (backend === 'sakana') {
    if (
      requested.effort === 'xhigh' ||
      requested.effort === 'max' ||
      (requested.fromUltrathink && requested.effort === 'high')
    ) {
      return 'xhigh'
    }
    // Sakana Fugu currently rejects low/medium. Use the lowest accepted level.
    return 'high'
  }
  return mapReasoningEffortForCodex(requested, modelId)
}

function resolveVerbosity(): CodexVerbosity {
  const raw = process.env.CLAUDE_CODE_GPT_VERBOSITY?.toLowerCase()
  if (raw === 'medium' || raw === 'high') return raw
  return 'low'
}

function shouldForwardMaxOutputTokens(): boolean {
  const raw = process.env.CLAUDE_CODE_GPT_FORWARD_MAX_OUTPUT_TOKENS
  return raw === '1' || raw?.toLowerCase() === 'true'
}

function translateToolChoice(toolChoice: unknown): string {
  if (!toolChoice || typeof toolChoice !== 'object') return 'auto'
  const type = (toolChoice as Record<string, unknown>).type
  if (type === 'none') return 'none'
  if (type === 'any') return 'required'
  return 'auto'
}

function buildPromptCacheKey(): string {
  const explicit = process.env.CLAUDE_CODE_GPT_PROMPT_CACHE_KEY
  if (explicit) return explicit
  return `fexor-code:${process.cwd()}`
}

function shouldInterceptMessagesUrl(url: string): boolean {
  try {
    return new URL(url).pathname.endsWith('/v1/messages')
  } catch {
    return url.endsWith('/v1/messages')
  }
}

function normalizeSakanaResponsesUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl)
    if (/\/v1\/?$/i.test(url.pathname)) {
      url.pathname = url.pathname.replace(/\/?$/i, '/responses')
    }
    return url.toString()
  } catch {
    return /\/v1\/?$/i.test(baseUrl)
      ? baseUrl.replace(/\/?$/i, '/responses')
      : baseUrl
  }
}

// ── Translation: Anthropic request → Codex request ──────────────────

function translateTools(
  anthropicTools: AnthropicTool[],
): Array<Record<string, unknown>> {
  return anthropicTools.map(tool => ({
    type: 'function',
    name: tool.name,
    description: tool.description || '',
    parameters: tool.input_schema || { type: 'object', properties: {} },
    strict: false,
  }))
}

function toolResultToText(block: AnthropicContentBlock): string {
  if (typeof block.content === 'string') return block.content
  if (!Array.isArray(block.content)) return ''
  return block.content
    .map(item => {
      if (item.type === 'text') return item.text ?? ''
      if (item.type === 'image') return '[Image data attached]'
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function assistantTextItem(text: string): Record<string, unknown> {
  return {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [] }],
    status: 'completed',
  }
}

function translateMessages(
  anthropicMessages: AnthropicMessage[],
): Array<Record<string, unknown>> {
  const codexInput: Array<Record<string, unknown>> = []
  let toolCallCounter = 0

  for (const msg of anthropicMessages) {
    if (typeof msg.content === 'string') {
      if (msg.role === 'assistant') {
        codexInput.push(assistantTextItem(msg.content))
      } else {
        codexInput.push({ role: msg.role, content: msg.content })
      }
      continue
    }

    if (!Array.isArray(msg.content)) continue

    if (msg.role === 'user') {
      let contentBlocks: Array<Record<string, unknown>> = []
      const flushContentBlocks = () => {
        if (contentBlocks.length === 0) return
        if (
          contentBlocks.length === 1 &&
          contentBlocks[0]?.type === 'input_text'
        ) {
          codexInput.push({ role: 'user', content: contentBlocks[0].text })
        } else {
          codexInput.push({ role: 'user', content: contentBlocks })
        }
        contentBlocks = []
      }

      for (const block of msg.content) {
        if (block.type === 'tool_result') {
          flushContentBlocks()
          codexInput.push({
            type: 'function_call_output',
            call_id: block.tool_use_id || `call_${toolCallCounter++}`,
            output: toolResultToText(block),
          })
        } else if (block.type === 'text' && typeof block.text === 'string') {
          contentBlocks.push({ type: 'input_text', text: block.text })
        } else if (
          block.type === 'image' &&
          block.source?.type === 'base64' &&
          block.source.media_type &&
          block.source.data
        ) {
          contentBlocks.push({
            type: 'input_image',
            image_url: `data:${block.source.media_type};base64,${block.source.data}`,
          })
        }
      }
      flushContentBlocks()
      continue
    }

    if (msg.role === 'assistant') {
      for (const block of msg.content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          codexInput.push(assistantTextItem(block.text))
        } else if (block.type === 'tool_use') {
          codexInput.push({
            type: 'function_call',
            call_id: block.id || `call_${toolCallCounter++}`,
            name: block.name || '',
            arguments: JSON.stringify(block.input || {}),
          })
        }
      }
    }
  }

  return codexInput
}

function translateToCodexBody(
  anthropicBody: Record<string, unknown>,
  backend: ResponsesBackend = 'codex',
): {
  codexBody: Record<string, unknown>
  codexModel: string
  isStreaming: boolean
} {
  const anthropicMessages = (anthropicBody.messages || []) as AnthropicMessage[]
  const systemPrompt = anthropicBody.system as
    | string
    | Array<{ type: string; text?: string; cache_control?: unknown }>
    | undefined
  const claudeModel = anthropicBody.model as string
  const anthropicTools = (anthropicBody.tools || []) as AnthropicTool[]
  const outputConfig = anthropicBody.output_config as
    | Record<string, unknown>
    | undefined
  const toolChoice = anthropicBody.tool_choice

  const codexModel = mapClaudeModelToResponses(claudeModel, backend)
  const instructions =
    typeof systemPrompt === 'string'
      ? systemPrompt
      : Array.isArray(systemPrompt)
        ? systemPrompt
            .filter(block => block.type === 'text' && typeof block.text === 'string')
            .map(block => block.text!)
            .join('\n')
        : ''

  const codexBody: Record<string, unknown> =
    backend === 'sakana'
      ? {
          model: codexModel,
          stream: true,
          instructions,
          input: translateMessages(anthropicMessages),
          tool_choice: translateToolChoice(toolChoice),
          parallel_tool_calls: true,
        }
      : {
          model: codexModel,
          store: false,
          stream: true,
          instructions,
          input: translateMessages(anthropicMessages),
          tool_choice: translateToolChoice(toolChoice),
          parallel_tool_calls: true,
          include: [],
          prompt_cache_key: buildPromptCacheKey(),
          client_metadata: {
            originator: 'fexor-code',
          },
          text: { verbosity: resolveVerbosity() },
        }

  const maxTokens = anthropicBody.max_tokens
  if (
    (backend === 'sakana' || shouldForwardMaxOutputTokens()) &&
    typeof maxTokens === 'number' &&
    Number.isFinite(maxTokens)
  ) {
    codexBody.max_output_tokens = Math.max(1, Math.floor(maxTokens))
  }

  if (responsesModelSupportsReasoning(codexModel, backend)) {
    const requestedEffort = extractReasoningEffort(
      anthropicMessages,
      instructions,
      outputConfig,
      backend,
    )
    if (requestedEffort) {
      codexBody.reasoning = {
        effort: mapReasoningEffortForResponses(
          requestedEffort,
          codexModel,
          backend,
        ),
      }
      if (backend === 'codex') {
        codexBody.include = ['reasoning.encrypted_content']
      }
    }
  }

  if (anthropicTools.length > 0) {
    codexBody.tools = translateTools(anthropicTools)
  }

  return {
    codexBody,
    codexModel,
    isStreaming: anthropicBody.stream === true,
  }
}

// ── Codex SSE parsing ───────────────────────────────────────────────

function formatSSE(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`
}

function enqueueSSE(
  controller: ReadableStreamDefaultController,
  encoder: TextEncoder,
  event: string,
  data: Record<string, unknown>,
) {
  controller.enqueue(encoder.encode(formatSSE(event, JSON.stringify(data))))
}

async function readCodexSSE(
  codexResponse: Response,
  onEvent: (event: Record<string, unknown>) => void | Promise<void>,
): Promise<void> {
  const reader = codexResponse.body?.getReader()
  if (!reader) throw new Error('Codex response did not include a body')

  const decoder = new TextDecoder()
  let buffer = ''

  const processLine = async (line: string) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('event: ')) return
    if (!trimmed.startsWith('data: ')) return
    const data = trimmed.slice(6)
    if (data === '[DONE]') return
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(data) as Record<string, unknown>
    } catch {
      // Ignore malformed stream fragments. The API's completed/error event will
      // still decide the final request state.
      return
    }
    await onEvent(parsed)
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines) {
      await processLine(line)
    }
  }

  if (buffer.length > 0) {
    await processLine(buffer)
  }
}

class CodexStreamError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CodexStreamError'
  }
}

function readStringField(
  value: Record<string, unknown> | undefined,
  field: string,
): string | null {
  const raw = value?.[field]
  return typeof raw === 'string' && raw.length > 0 ? raw : null
}

function describeCodexErrorDetail(detail: unknown): string | null {
  if (typeof detail === 'string' && detail.length > 0) return detail
  if (!detail || typeof detail !== 'object') return null

  const obj = detail as Record<string, unknown>
  return (
    readStringField(obj, 'message') ||
    readStringField(obj, 'detail') ||
    readStringField(obj, 'reason') ||
    readStringField(obj, 'code') ||
    null
  )
}

function extractCodexStreamError(event: Record<string, unknown>): string | null {
  const eventType = event.type
  if (eventType !== 'error' && eventType !== 'response.failed') return null

  const response =
    event.response && typeof event.response === 'object'
      ? (event.response as Record<string, unknown>)
      : undefined

  const candidates = [
    event.error,
    response?.error,
    event.incomplete_details,
    response?.incomplete_details,
    event,
  ]

  for (const candidate of candidates) {
    const message = describeCodexErrorDetail(candidate)
    if (message) return message
  }

  return `Codex stream failed with event ${String(eventType)}`
}

function assertCodexStreamOk(event: Record<string, unknown>): void {
  const message = extractCodexStreamError(event)
  if (message) throw new CodexStreamError(message)
}

// ── Response translation: Codex SSE → Anthropic SSE ─────────────────

function getItemId(item: Record<string, unknown>): string | undefined {
  return typeof item.id === 'string' ? item.id : undefined
}

function getCallId(item: Record<string, unknown>): string | undefined {
  return typeof item.call_id === 'string' ? item.call_id : undefined
}

function textFromCodexContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(item => {
      if (!item || typeof item !== 'object') return ''
      const obj = item as Record<string, unknown>
      if (typeof obj.text === 'string') return obj.text
      if (typeof obj.output_text === 'string') return obj.output_text
      return ''
    })
    .filter(Boolean)
    .join('')
}

function parseToolInput(argumentsJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argumentsJson)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

async function translateCodexStreamToAnthropic(
  codexResponse: Response,
  codexModel: string,
): Promise<Response> {
  const messageId = `msg_codex_${Date.now()}`

  const readable = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()
      let contentBlockIndex = 0
      let textBlockIndex: number | null = null
      let reasoningBlockIndex: number | null = null
      let currentMessageHadTextDeltas = false
      let outputTokens = 0
      let inputTokens = 0
      let hadToolCalls = false
      const toolBlocks = new Map<string, ToolBlockState>()
      let lastToolKey: string | null = null

      const startTextBlock = () => {
        if (textBlockIndex !== null) return textBlockIndex
        closeReasoningBlock()
        textBlockIndex = contentBlockIndex++
        enqueueSSE(controller, encoder, 'content_block_start', {
          type: 'content_block_start',
          index: textBlockIndex,
          content_block: { type: 'text', text: '' },
        })
        return textBlockIndex
      }

      const closeTextBlock = () => {
        if (textBlockIndex === null) return
        enqueueSSE(controller, encoder, 'content_block_stop', {
          type: 'content_block_stop',
          index: textBlockIndex,
        })
        textBlockIndex = null
      }

      const startReasoningBlock = () => {
        if (reasoningBlockIndex !== null) return reasoningBlockIndex
        closeTextBlock()
        reasoningBlockIndex = contentBlockIndex++
        enqueueSSE(controller, encoder, 'content_block_start', {
          type: 'content_block_start',
          index: reasoningBlockIndex,
          content_block: { type: 'thinking', thinking: '' },
        })
        return reasoningBlockIndex
      }

      function closeReasoningBlock() {
        if (reasoningBlockIndex === null) return
        enqueueSSE(controller, encoder, 'content_block_stop', {
          type: 'content_block_stop',
          index: reasoningBlockIndex,
        })
        reasoningBlockIndex = null
      }

      const rememberToolBlock = (state: ToolBlockState) => {
        toolBlocks.set(state.itemId, state)
        toolBlocks.set(state.callId, state)
        lastToolKey = state.itemId
      }

      const startToolBlock = (item: Record<string, unknown>) => {
        closeTextBlock()
        closeReasoningBlock()
        const itemId = getItemId(item) || getCallId(item) || `fc_${Date.now()}`
        const callId = getCallId(item) || itemId
        const existing = toolBlocks.get(itemId) || toolBlocks.get(callId)
        if (existing) return existing

        const state: ToolBlockState = {
          index: contentBlockIndex++,
          itemId,
          callId,
          name: typeof item.name === 'string' ? item.name : '',
          args: typeof item.arguments === 'string' ? item.arguments : '',
          hasArgumentDeltas: false,
          closed: false,
        }
        rememberToolBlock(state)
        hadToolCalls = true
        enqueueSSE(controller, encoder, 'content_block_start', {
          type: 'content_block_start',
          index: state.index,
          content_block: {
            type: 'tool_use',
            id: state.callId,
            name: state.name,
            input: {},
          },
        })
        return state
      }

      const findToolBlock = (event: Record<string, unknown>) => {
        const key =
          (typeof event.item_id === 'string' && event.item_id) ||
          (typeof event.call_id === 'string' && event.call_id) ||
          lastToolKey
        return key ? toolBlocks.get(key) : undefined
      }

      const emitToolArguments = (state: ToolBlockState, delta: string) => {
        if (state.closed || delta.length === 0) return
        state.args += delta
        state.hasArgumentDeltas = true
        enqueueSSE(controller, encoder, 'content_block_delta', {
          type: 'content_block_delta',
          index: state.index,
          delta: {
            type: 'input_json_delta',
            partial_json: delta,
          },
        })
      }

      const closeToolBlock = (state: ToolBlockState) => {
        if (state.closed) return
        enqueueSSE(controller, encoder, 'content_block_stop', {
          type: 'content_block_stop',
          index: state.index,
        })
        state.closed = true
      }

      enqueueSSE(controller, encoder, 'message_start', {
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          content: [],
          model: codexModel,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      })
      enqueueSSE(controller, encoder, 'ping', { type: 'ping' })

      try {
        await readCodexSSE(codexResponse, event => {
          assertCodexStreamOk(event)

          const eventType = event.type as string

          if (eventType === 'response.output_item.added') {
            const item = event.item as Record<string, unknown> | undefined
            if (!item) return
            if (item.type === 'message') {
              currentMessageHadTextDeltas = false
            } else if (item.type === 'reasoning') {
              startReasoningBlock()
            } else if (item.type === 'function_call') {
              startToolBlock(item)
            }
            return
          }

          if (eventType === 'response.output_text.delta') {
            const text = event.delta
            if (typeof text !== 'string' || text.length === 0) return
            const index = startTextBlock()
            currentMessageHadTextDeltas = true
            enqueueSSE(controller, encoder, 'content_block_delta', {
              type: 'content_block_delta',
              index,
              delta: { type: 'text_delta', text },
            })
            outputTokens += 1
            return
          }

          if (
            eventType === 'response.reasoning.delta' ||
            eventType === 'response.reasoning_text.delta' ||
            eventType === 'response.reasoning_summary_text.delta'
          ) {
            const text = event.delta
            if (typeof text !== 'string' || text.length === 0) return
            const index = startReasoningBlock()
            enqueueSSE(controller, encoder, 'content_block_delta', {
              type: 'content_block_delta',
              index,
              delta: { type: 'thinking_delta', thinking: text },
            })
            outputTokens += 1
            return
          }

          if (eventType === 'response.function_call_arguments.delta') {
            const delta = event.delta
            const state = findToolBlock(event)
            if (typeof delta === 'string' && state) {
              emitToolArguments(state, delta)
            }
            return
          }

          if (eventType === 'response.function_call_arguments.done') {
            const state = findToolBlock(event)
            if (state && typeof event.arguments === 'string') {
              state.args = event.arguments
            }
            return
          }

          if (eventType === 'response.output_item.done') {
            const item = event.item as Record<string, unknown> | undefined
            if (!item) return

            if (item.type === 'function_call') {
              const state = startToolBlock(item)
              const finalArgs =
                typeof item.arguments === 'string' ? item.arguments : state.args
              if (!state.hasArgumentDeltas && finalArgs.length > 0) {
                emitToolArguments(state, finalArgs)
              } else {
                state.args = finalArgs
              }
              closeToolBlock(state)
            } else if (item.type === 'message') {
              if (!currentMessageHadTextDeltas) {
                const text = textFromCodexContent(item.content)
                if (text.length > 0) {
                  const index = startTextBlock()
                  enqueueSSE(controller, encoder, 'content_block_delta', {
                    type: 'content_block_delta',
                    index,
                    delta: { type: 'text_delta', text },
                  })
                }
              }
              closeTextBlock()
            } else if (item.type === 'reasoning') {
              closeReasoningBlock()
            }
            return
          }

          if (eventType === 'response.completed') {
            const response = event.response as Record<string, unknown> | undefined
            const usage = response?.usage as Record<string, number> | undefined
            if (usage) {
              outputTokens = usage.output_tokens || outputTokens
              inputTokens = usage.input_tokens || inputTokens
            }
          }
        })
      } catch (err) {
        enqueueSSE(controller, encoder, 'error', {
          type: 'error',
          error: {
            type: 'api_error',
            message: err instanceof Error ? err.message : String(err),
          },
        })
        controller.close()
        return
      }

      closeTextBlock()
      closeReasoningBlock()
      for (const state of new Set(toolBlocks.values())) {
        closeToolBlock(state)
      }

      enqueueSSE(controller, encoder, 'message_delta', {
        type: 'message_delta',
        delta: {
          stop_reason: hadToolCalls ? 'tool_use' : 'end_turn',
          stop_sequence: null,
        },
        usage: { output_tokens: outputTokens },
      })
      enqueueSSE(controller, encoder, 'message_stop', {
        type: 'message_stop',
        'amazon-bedrock-invocationMetrics': {
          inputTokenCount: inputTokens,
          outputTokenCount: outputTokens,
          invocationLatency: 0,
          firstByteLatency: 0,
        },
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      })
      controller.close()
    },
  })

  return new Response(readable, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'x-request-id': messageId,
    },
  })
}

async function translateCodexStreamToAnthropicMessage(
  codexResponse: Response,
  codexModel: string,
): Promise<Response> {
  const responseId = `msg_codex_${Date.now()}`
  const content: Array<Record<string, unknown>> = []
  let fallbackText = ''
  let inputTokens = 0
  let outputTokens = 0
  let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' = 'end_turn'

  await readCodexSSE(codexResponse, event => {
    assertCodexStreamOk(event)

    const eventType = event.type as string

    if (eventType === 'response.output_text.delta') {
      const text = event.delta
      if (typeof text === 'string') fallbackText += text
      return
    }

    if (eventType === 'response.output_item.done') {
      const item = event.item as Record<string, unknown> | undefined
      if (!item) return

      if (item.type === 'message') {
        const text = textFromCodexContent(item.content)
        if (text.length > 0) {
          content.push({ type: 'text', text })
          fallbackText = ''
        }
      } else if (item.type === 'function_call') {
        const callId = getCallId(item) || getItemId(item) || `toolu_${Date.now()}`
        const args = typeof item.arguments === 'string' ? item.arguments : '{}'
        content.push({
          type: 'tool_use',
          id: callId,
          name: typeof item.name === 'string' ? item.name : '',
          input: parseToolInput(args),
        })
        stopReason = 'tool_use'
      }
      return
    }

    if (eventType === 'response.completed') {
      const response = event.response as Record<string, unknown> | undefined
      const usage = response?.usage as Record<string, number> | undefined
      if (usage) {
        inputTokens = usage.input_tokens || inputTokens
        outputTokens = usage.output_tokens || outputTokens
      }
      const incompleteReason = (response?.incomplete_details as
        | Record<string, unknown>
        | undefined)?.reason
      if (incompleteReason === 'max_output_tokens') {
        stopReason = 'max_tokens'
      }
    }
  })

  if (content.length === 0 && fallbackText.length > 0) {
    content.push({ type: 'text', text: fallbackText })
  }

  const message = {
    id: responseId,
    type: 'message',
    role: 'assistant',
    model: codexModel,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    },
  }

  return new Response(JSON.stringify(message), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'x-request-id': responseId,
    },
  })
}

function codexErrorResponse(
  message: string,
  status: number,
  stream: boolean,
): Response {
  const body = {
    type: 'error',
    error: {
      type: status === 401 ? 'authentication_error' : 'api_error',
      message,
    },
  }

  if (!stream) {
    return new Response(JSON.stringify(body), {
      status,
      headers: {
        'Content-Type': 'application/json',
        ...(status === 401 ? { 'x-should-retry': 'false' } : {}),
      },
    })
  }

  return new Response(formatSSE('error', JSON.stringify(body)), {
    status,
    headers: {
      'Content-Type': 'text/event-stream',
      ...(status === 401 ? { 'x-should-retry': 'false' } : {}),
    },
  })
}

// ── Main fetch interceptor ──────────────────────────────────────────

function createResponsesFetch({
  backend,
  accessToken,
  apiKey,
  baseFetch,
  baseUrl,
}: ResponsesFetchOptions): (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response> {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input)

    if (!shouldInterceptMessagesUrl(url)) {
      return baseFetch(input, init)
    }

    let anthropicBody: Record<string, unknown>
    try {
      const bodyText =
        init?.body instanceof ReadableStream
          ? await new Response(init.body).text()
          : typeof init?.body === 'string'
            ? init.body
            : '{}'
      anthropicBody = JSON.parse(bodyText) as Record<string, unknown>
    } catch {
      anthropicBody = {}
    }

    const { codexBody, codexModel, isStreaming } = translateToCodexBody(
      anthropicBody,
      backend,
    )

    if (backend === 'sakana') {
      if (!apiKey) {
        return codexErrorResponse(
          'Sakana API key is missing. Set SAKANA_API_KEY or store it in the sakana_api_key Keychain service.',
          401,
          isStreaming,
        )
      }

      const sakanaResponse = await baseFetch(baseUrl ?? DEFAULT_SAKANA_BASE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(codexBody),
        signal: init?.signal,
      })

      if (!sakanaResponse.ok) {
        const errorText = await sakanaResponse.text().catch(() => '')
        return codexErrorResponse(
          `Sakana API error (${sakanaResponse.status}): ${errorText}`,
          sakanaResponse.status,
          isStreaming,
        )
      }

      try {
        return isStreaming
          ? translateCodexStreamToAnthropic(sakanaResponse, codexModel)
          : await translateCodexStreamToAnthropicMessage(
              sakanaResponse,
              codexModel,
            )
      } catch (err) {
        return codexErrorResponse(
          err instanceof Error ? err.message : String(err),
          500,
          isStreaming,
        )
      }
    }

    if (!accessToken) {
      return codexErrorResponse(
        'Codex OAuth token is missing. Please run /login again and choose OpenAI Codex account.',
        401,
        isStreaming,
      )
    }

    let auth: { accessToken: string; accountId: string }
    try {
      auth = await resolveCodexAuth(accessToken)
    } catch (err) {
      return codexErrorResponse(String(err), 401, isStreaming)
    }

    const callCodex = (currentAuth: {
      accessToken: string
      accountId: string
    }) =>
      baseFetch(CODEX_BASE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          Authorization: `Bearer ${currentAuth.accessToken}`,
          'chatgpt-account-id': currentAuth.accountId,
          originator: 'pi',
          'OpenAI-Beta': 'responses=experimental',
        },
        body: JSON.stringify(codexBody),
        signal: init?.signal,
      })

    let codexResponse = await callCodex(auth)
    if (codexResponse.status === 401) {
      try {
        auth = await forceRefreshCodexAuth()
        codexResponse = await callCodex(auth)
      } catch (err) {
        return codexErrorResponse(String(err), 401, isStreaming)
      }
    }

    if (!codexResponse.ok) {
      const errorText = await codexResponse.text().catch(() => '')
      return codexErrorResponse(
        `Codex API error (${codexResponse.status}): ${errorText}`,
        codexResponse.status,
        isStreaming,
      )
    }

    try {
      return isStreaming
        ? translateCodexStreamToAnthropic(codexResponse, codexModel)
        : await translateCodexStreamToAnthropicMessage(codexResponse, codexModel)
    } catch (err) {
      return codexErrorResponse(
        err instanceof Error ? err.message : String(err),
        500,
        isStreaming,
      )
    }
  }
}

/**
 * Creates a fetch function that intercepts Anthropic API calls and routes them
 * to Codex. Only used when OpenAI mode and Codex OAuth are active.
 */
export function createCodexFetch(
  accessToken: string,
  baseFetch: typeof globalThis.fetch = globalThis.fetch,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return createResponsesFetch({
    backend: 'codex',
    accessToken,
    baseFetch,
  })
}

/**
 * Creates a fetch function that routes Anthropic Messages-shaped SDK calls to
 * Sakana's OpenAI-compatible Responses endpoint.
 */
export function createSakanaFetch(
  apiKey: string,
  baseFetch: typeof globalThis.fetch = globalThis.fetch,
  baseUrl: string = DEFAULT_SAKANA_BASE_URL,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return createResponsesFetch({
    backend: 'sakana',
    apiKey,
    baseFetch,
    baseUrl: normalizeSakanaResponsesUrl(baseUrl),
  })
}
