/**
 * Commit attribution tracking hooks (ant-only feature, gated behind
 * feature('COMMIT_ATTRIBUTION')).
 *
 * Registers a fast, internal PostToolUse callback that records Claude's
 * character contribution to files edited via the Edit/Write tools. The
 * accumulated contribution is later turned into commit co-author / attribution
 * trailers (see commitAttribution.ts + the prepare-commit-msg hook).
 *
 * The callback is on the hot PostToolUse path, so it is intentionally cheap:
 * it returns {} (never blocks), ignores the abort signal, and routes all
 * state mutation through the synchronous context.updateAttributionState
 * setter rather than doing async work inline. The only I/O it performs is a
 * memoized sync read of the post-edit file content (Edit's tool_response only
 * carries the original content, not the resulting file), backed by
 * fileContentCache so repeated edits to the same file don't re-read disk.
 */
import { registerHookCallbacks } from '../bootstrap/state.js'
import type {
  HookInput,
  HookJSONOutput,
} from '../entrypoints/agentSdkTypes.js'
import { FILE_EDIT_TOOL_NAME } from '../tools/FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from '../tools/FileWriteTool/prompt.js'
import type { HookCallback, HookCallbackContext } from '../types/hooks.js'
import {
  type AttributionState,
  normalizeFilePath,
  trackFileModification,
} from './commitAttribution.js'
import { logForDebugging } from './debug.js'
import { getFsImplementation } from './fsOperations.js'

/**
 * Cache of last-known file content keyed by normalized (cwd-relative) path.
 * Lets the PostToolUse callback compute the new file content for an Edit
 * without re-reading disk on every edit to the same file. Also seeds the
 * "old content" baseline for tools whose response omits it.
 */
const fileContentCache = new Map<string, string>()

/**
 * Read a file's current content as UTF-8, returning null on any failure
 * (missing file, permission error, binary). Uses the shared fs implementation
 * so test fakes and the real filesystem behave identically.
 */
function readFileContent(absPath: string): string | null {
  try {
    return getFsImplementation().readFileSync(absPath, { encoding: 'utf8' })
  } catch {
    return null
  }
}

/**
 * Resolve the (oldContent, newContent) pair for a completed Edit/Write tool
 * use. Returns null when the change can't be attributed (unknown tool, missing
 * path, unreadable result).
 */
function resolveContentChange(
  toolName: string,
  toolResponse: unknown,
): { filePath: string; oldContent: string; newContent: string } | null {
  if (!toolResponse || typeof toolResponse !== 'object') {
    return null
  }
  const response = toolResponse as Record<string, unknown>
  const filePath = response.filePath
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return null
  }

  if (toolName === FILE_WRITE_TOOL_NAME) {
    // Write's response carries both sides directly.
    const newContent =
      typeof response.content === 'string' ? response.content : ''
    const oldContent =
      typeof response.originalFile === 'string' ? response.originalFile : ''
    return { filePath, oldContent, newContent }
  }

  if (toolName === FILE_EDIT_TOOL_NAME) {
    // Edit's response carries the pre-edit file (originalFile) but not the
    // resulting file. Read it back (cached) to get the new content.
    const oldContent =
      typeof response.originalFile === 'string' ? response.originalFile : ''
    const newContent = readFileContent(filePath)
    if (newContent === null) {
      return null
    }
    return { filePath, oldContent, newContent }
  }

  return null
}

/**
 * PostToolUse callback that accumulates Claude's char contribution for the
 * file touched by an Edit/Write tool use. Fast path: returns {} immediately
 * for non-file events and never inspects the abort signal.
 */
async function handleAttributionPostToolUse(
  input: HookInput,
  _toolUseID: string | null,
  _signal: AbortSignal | undefined,
  _hookIndex?: number,
  context?: HookCallbackContext,
): Promise<HookJSONOutput> {
  if (input.hook_event_name !== 'PostToolUse') return {}
  if (!context) return {}

  const change = resolveContentChange(input.tool_name, input.tool_response)
  if (!change) return {}

  const normalizedPath = normalizeFilePath(change.filePath)
  fileContentCache.set(normalizedPath, change.newContent)

  const userModified =
    typeof input.tool_response === 'object' &&
    input.tool_response !== null &&
    (input.tool_response as Record<string, unknown>).userModified === true

  context.updateAttributionState((prev: AttributionState) =>
    trackFileModification(
      prev,
      change.filePath,
      change.oldContent,
      change.newContent,
      userModified,
    ),
  )

  logForDebugging(
    `Attribution: recorded ${input.tool_name} change for ${normalizedPath}`,
  )

  return {}
}

/**
 * Register commit attribution tracking hooks.
 * Called during CLI initialization (setup.ts) when COMMIT_ATTRIBUTION is on.
 */
export function registerAttributionHooks(): void {
  const hook: HookCallback = {
    type: 'callback',
    callback: handleAttributionPostToolUse,
    timeout: 1, // Very short timeout — just bookkeeping.
    internal: true,
  }

  registerHookCallbacks({
    PostToolUse: [
      { matcher: FILE_EDIT_TOOL_NAME, hooks: [hook] },
      { matcher: FILE_WRITE_TOOL_NAME, hooks: [hook] },
    ],
  })
}

/**
 * Drop cache entries for files that no longer exist on disk. Called after
 * compaction to bound the cache without discarding live entries (which would
 * force a disk re-read on the next edit).
 */
export function sweepFileContentCache(): void {
  const fs = getFsImplementation()
  let removed = 0
  for (const [normalizedPath, content] of fileContentCache) {
    try {
      const current = fs.readFileSync(normalizedPath, { encoding: 'utf8' })
      if (current === content) continue
    } catch {
      // Unreadable/missing — drop the stale entry.
    }
    fileContentCache.delete(normalizedPath)
    removed++
  }
  if (removed > 0) {
    logForDebugging(`Attribution: swept ${removed} file content cache entries`)
  }
}

/**
 * Clear all attribution caches (file content cache + pending tool states).
 * Called from the /clear command's cache reset.
 */
export function clearAttributionCaches(): void {
  fileContentCache.clear()
  logForDebugging('Attribution: cleared attribution caches')
}
