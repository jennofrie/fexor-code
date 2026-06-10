import { z } from 'zod/v4'
import type { ToolUseContext } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { snipCompactIfNeeded } from '../../services/compact/snipCompact.js'

const SNIP_TOOL_NAME = 'Snip'

const inputSchema = lazySchema(() => z.strictObject({}))
type InputSchema = ReturnType<typeof inputSchema>
export type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    tokensFreed: z.number(),
    executed: z.boolean(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

export const SnipTool = buildTool({
  name: SNIP_TOOL_NAME,
  searchHint: 'drop stale conversation history to free context',
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },
  toAutoClassifierInput() {
    return SNIP_TOOL_NAME
  },
  async description() {
    return 'Drop a stale range of conversation history to free up context. Recent messages are preserved.'
  },
  async prompt() {
    return 'Removes stale earlier conversation history to free up context, keeping the recent protected tail intact. Use when the conversation has grown long and older turns are no longer needed.'
  },
  async call(_input: Input, context: ToolUseContext) {
    const { tokensFreed, executed } = snipCompactIfNeeded(context.messages, {
      force: true,
    })
    return { data: { tokensFreed, executed } }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: output.executed
        ? `Snipped history, freed ~${output.tokensFreed} tokens.`
        : 'Nothing to snip.',
    }
  },
  renderToolUseMessage() {
    return ''
  },
} satisfies ToolDef<InputSchema, Output>)
