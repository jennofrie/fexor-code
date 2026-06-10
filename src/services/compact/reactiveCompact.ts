import type { QuerySource } from '../../constants/querySource.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import { logError } from '../../utils/log.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import {
  isMediaSizeErrorMessage,
  isPromptTooLongMessage,
} from '../api/errors.js'
import {
  type CompactionResult,
  ERROR_MESSAGE_USER_ABORT,
  compactConversation,
  stripImagesFromMessages,
} from './compact.js'
import { runPostCompactCleanup } from './postCompactCleanup.js'

// Reactive compaction reacts to the API's prompt-too-long / media-size
// rejections after a request fails, rather than preempting based on a token
// estimate (autoCompact's job). Modeled on autoCompactIfNeeded, minus the
// proactive threshold checks: by the time we get here the API has already
// told us the prompt is over the limit.

// GrowthBook flag controlling whether reactive compaction is active. Matches
// the gate autoCompact.ts consults to suppress proactive autocompact.
const REACTIVE_COMPACT_FLAG = 'tengu_cobalt_raccoon'

export function isReactiveCompactEnabled(): boolean {
  return getFeatureValue_CACHED_MAY_BE_STALE(REACTIVE_COMPACT_FLAG, false)
}

// Reactive-only mode == reactive compact is the active strategy; the /compact
// command routes through the reactive path instead of legacy compaction.
export function isReactiveOnlyMode(): boolean {
  return isReactiveCompactEnabled()
}

// Predicates matching the message-level shape the query loop uses to decide
// whether to withhold an error from SDK callers (see isWithheldMaxOutputTokens
// in query.ts). Only fire when reactive compact is enabled — a disabled gate
// means no recovery path, so withholding would just drop the error.
export function isWithheldPromptTooLong(
  msg: Message | undefined,
): msg is AssistantMessage {
  return (
    isReactiveCompactEnabled() &&
    msg?.type === 'assistant' &&
    isPromptTooLongMessage(msg)
  )
}

export function isWithheldMediaSizeError(
  msg: Message | undefined,
): msg is AssistantMessage {
  return (
    isReactiveCompactEnabled() &&
    msg?.type === 'assistant' &&
    isMediaSizeErrorMessage(msg)
  )
}

/**
 * Post-413 recovery for the query loop. Strips oversized media first (cheap,
 * preserves granular context), then summarizes via compactConversation.
 * Returns the CompactionResult on success (caller feeds it to
 * buildPostCompactMessages) or null when recovery isn't possible.
 */
export async function tryReactiveCompact(params: {
  hasAttempted: boolean
  querySource: QuerySource
  aborted: boolean
  messages: Message[]
  cacheSafeParams: CacheSafeParams
}): Promise<CompactionResult | null> {
  const { hasAttempted, aborted, messages, cacheSafeParams } = params
  // Single-shot per turn: a post-compact prompt that still 413s would spiral.
  if (hasAttempted || aborted || messages.length === 0) {
    return null
  }

  const isMedia = isWithheldMediaSizeError(messages.at(-1))
  const input = isMedia ? stripImagesFromMessages(messages) : messages

  try {
    return await compactConversation(
      input,
      cacheSafeParams.toolUseContext,
      { ...cacheSafeParams, forkContextMessages: input },
      true, // suppress follow-up questions
      undefined, // no custom instructions
      true, // isAutoCompact
    )
  } catch (error) {
    logError(error)
    return null
  } finally {
    runPostCompactCleanup(params.querySource)
  }
}

type ReactiveOutcome =
  | { ok: true; result: CompactionResult }
  | {
      ok: false
      reason:
        | 'too_few_groups'
        | 'aborted'
        | 'exhausted'
        | 'error'
        | 'media_unstrippable'
    }

/**
 * Reactive path for the manual /compact command. Same machinery as
 * tryReactiveCompact, but returns a tagged outcome so the command can
 * translate failures into its user-facing error messages.
 */
export async function reactiveCompactOnPromptTooLong(
  messages: Message[],
  cacheSafeParams: CacheSafeParams,
  options: { customInstructions?: string; trigger: 'manual' },
): Promise<ReactiveOutcome> {
  if (messages.length === 0) {
    return { ok: false, reason: 'too_few_groups' }
  }
  if (cacheSafeParams.toolUseContext.abortController.signal.aborted) {
    return { ok: false, reason: 'aborted' }
  }

  try {
    const result = await compactConversation(
      messages,
      cacheSafeParams.toolUseContext,
      cacheSafeParams,
      false, // manual /compact may surface follow-up questions
      options.customInstructions,
      false, // not autocompact
    )
    return { ok: true, result }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === ERROR_MESSAGE_USER_ABORT
    ) {
      return { ok: false, reason: 'aborted' }
    }
    logError(error)
    return { ok: false, reason: 'error' }
  } finally {
    runPostCompactCleanup('compact')
  }
}
