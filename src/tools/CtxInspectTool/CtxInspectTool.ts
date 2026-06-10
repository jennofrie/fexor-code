import { z } from 'zod/v4'
import type { ToolDef } from '../../Tool.js'
import { buildTool } from '../../Tool.js'
import {
  getStats,
  isContextCollapseEnabled,
} from '../../services/contextCollapse/index.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonStringify } from '../../utils/slowOperations.js'

export const CTX_INSPECT_TOOL_NAME = 'CtxInspect'

const inputSchema = lazySchema(() => z.strictObject({}))
type InputSchema = ReturnType<typeof inputSchema>
export type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    enabled: z.boolean(),
    collapsedSpans: z.number(),
    collapsedMessages: z.number(),
    stagedSpans: z.number(),
    health: z.object({
      totalErrors: z.number(),
      totalEmptySpawns: z.number(),
      totalSpawns: z.number(),
      emptySpawnWarningEmitted: z.boolean(),
      lastError: z.string().nullable(),
    }),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

export const CtxInspectTool = buildTool({
  name: CTX_INSPECT_TOOL_NAME,
  searchHint: 'inspect context collapse state and span statistics',
  maxResultSizeChars: 50_000,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled() {
    return isContextCollapseEnabled()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  isOpenWorld() {
    return false
  },
  toAutoClassifierInput() {
    return ''
  },
  async description() {
    return 'Inspect the current context-collapse state: how many spans and messages have been collapsed, how many spans are staged, and subsystem health counters. Read-only — does not modify the conversation.'
  },
  async prompt() {
    return 'Inspect the current context-collapse subsystem state. Returns the number of collapsed spans, collapsed messages, staged spans, and health counters (errors, spawns, empty spawns). Takes no input. This is a read-only diagnostic tool.'
  },
  async call() {
    const stats = getStats()
    return {
      data: {
        enabled: isContextCollapseEnabled(),
        collapsedSpans: stats.collapsedSpans,
        collapsedMessages: stats.collapsedMessages,
        stagedSpans: stats.stagedSpans,
        health: {
          totalErrors: stats.health.totalErrors,
          totalEmptySpawns: stats.health.totalEmptySpawns,
          totalSpawns: stats.health.totalSpawns,
          emptySpawnWarningEmitted: stats.health.emptySpawnWarningEmitted,
          lastError: stats.health.lastError,
        },
      },
    }
  },
  renderToolUseMessage() {
    return 'Inspecting context-collapse state'
  },
  renderToolResultMessage(output: Output) {
    return jsonStringify(output)
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID: string) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: jsonStringify(output),
    }
  },
} satisfies ToolDef<InputSchema, Output>)
