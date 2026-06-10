/**
 * Mid-turn task summary generator for `claude ps` (BG_SESSIONS).
 *
 * Fires periodically during a long-running agentic turn so the background
 * session list and CCR sidebar can show "what's happening right now" before
 * the post_turn_summary lands. The summary is generated with the small/fast
 * model off the current turn's fork context, then mirrored into the session's
 * external_metadata.task_summary via notifySessionMetadataChanged.
 *
 * Gated behind feature('BG_SESSIONS'); query.ts require()s this module only
 * when the flag is enabled, so the whole file is dead-code-eliminated from
 * builds that don't ship background sessions.
 */

import type { ToolUseContext } from '../Tool.js'
import type { Message } from '../types/message.js'
import { queryHaiku } from '../services/api/claude.js'
import { logForDebugging } from './debug.js'
import { toError } from './errors.js'
import { getContentText } from './messages.js'
import { notifySessionMetadataChanged } from './sessionState.js'
import { asSystemPrompt, type SystemPrompt } from './systemPromptType.js'

// Throttle: at most one summary every TASK_SUMMARY_INTERVAL_MS. The query loop
// also gates on a per-turn step cadence, but the wall-clock floor keeps a
// fast-stepping agent from hammering the small model.
const TASK_SUMMARY_INTERVAL_MS = 2 * 60 * 1000

// Keep the prompt small — only the trailing slice of the turn matters for
// "what's happening right now", and the small model truncates long inputs.
const MAX_CONTEXT_MESSAGES = 12
const MAX_TEXT_PER_MESSAGE = 400

const TASK_SUMMARY_SYSTEM_PROMPT = `You are labelling what a coding agent is currently working on, for a background-session list. Write a single short present-tense phrase (think status line, not a sentence) describing the work in progress.

Keep it under ~40 characters. Lead with the action and the most distinctive noun. Drop articles and filler.

Examples:
- Fixing auth redirect loop
- Adding tests for parser
- Refactoring query loop
- Reading config files`

let lastGeneratedAt = 0
let inFlight = false

/**
 * True when enough time has passed since the last summary that it's worth
 * spending a small-model call to refresh the session's task_summary.
 */
export function shouldGenerateTaskSummary(): boolean {
  if (inFlight) return false
  return Date.now() - lastGeneratedAt >= TASK_SUMMARY_INTERVAL_MS
}

export type MaybeGenerateTaskSummaryParams = {
  systemPrompt: SystemPrompt
  userContext: { [k: string]: string }
  systemContext: { [k: string]: string }
  toolUseContext: ToolUseContext
  forkContextMessages: Message[]
}

/**
 * Fire-and-forget: generate a fresh task summary off the current turn's
 * context and publish it to session metadata. Never throws — summaries are
 * best-effort progress decoration, so any failure is swallowed to debug.
 *
 * The throttle clock is advanced up front so concurrent turns can't stack
 * multiple in-flight summarizer calls.
 */
export function maybeGenerateTaskSummary(
  params: MaybeGenerateTaskSummaryParams,
): void {
  // Advance the clock before the async work so a second call in the same
  // tick is short-circuited by shouldGenerateTaskSummary's interval check.
  lastGeneratedAt = Date.now()
  inFlight = true
  void runTaskSummary(params).finally(() => {
    inFlight = false
  })
}

async function runTaskSummary(
  params: MaybeGenerateTaskSummaryParams,
): Promise<void> {
  const { toolUseContext, forkContextMessages } = params
  try {
    const transcript = buildTranscript(forkContextMessages)
    if (!transcript) return

    const response = await queryHaiku({
      systemPrompt: asSystemPrompt([TASK_SUMMARY_SYSTEM_PROMPT]),
      userPrompt: `Recent activity in this turn:\n\n${transcript}\n\nCurrent work label:`,
      signal: toolUseContext.abortController.signal,
      options: {
        // Reuse the summary-generation source — same small-model, non-billable
        // analytics bucket as the post-turn tool-use summarizer.
        querySource: 'tool_use_summary_generation',
        enablePromptCaching: false,
        agents: [],
        isNonInteractiveSession:
          toolUseContext.options.isNonInteractiveSession,
        hasAppendSystemPrompt: false,
        mcpTools: [],
      },
    })

    const summary = response.message.content
      .filter(block => block.type === 'text')
      .map(block => (block.type === 'text' ? block.text : ''))
      .join('')
      .trim()

    if (summary) {
      notifySessionMetadataChanged({ task_summary: summary })
    }
  } catch (error) {
    // Aborts and transient model failures are expected — task_summary is
    // non-critical decoration, so never surface it to the user.
    logForDebugging(
      `[taskSummary] generation failed: ${toError(error).message}`,
    )
  }
}

/**
 * Condense the trailing slice of the fork context into a compact transcript
 * the small model can label. Only user/assistant text is kept — tool result
 * blobs are dropped to keep the prompt focused on intent.
 */
function buildTranscript(messages: Message[]): string {
  const lines: string[] = []
  for (const message of messages.slice(-MAX_CONTEXT_MESSAGES)) {
    if (message.type !== 'user' && message.type !== 'assistant') continue
    const text = getContentText(message.message.content)
    if (!text) continue
    const role = message.type === 'user' ? 'User' : 'Assistant'
    lines.push(`${role}: ${text.slice(0, MAX_TEXT_PER_MESSAGE)}`)
  }
  return lines.join('\n')
}
