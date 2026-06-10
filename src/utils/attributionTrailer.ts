/**
 * Git-trailer formatting for commit / PR attribution.
 *
 * Split out of commitAttribution.ts so it can be tree-shaken out of external
 * builds: it embeds internal model codenames and trailer keys that should only
 * ship in builds with feature('COMMIT_ATTRIBUTION') enabled. Reached exclusively
 * via dynamic import() behind that feature flag (see attribution.ts and the
 * prepare-commit-msg hook installed by postCommitAttribution.ts).
 *
 * Trailer lines follow the git "Key: value" convention so that, when a PR body
 * becomes a squash-merge commit message verbatim (repos configured with
 * squash_merge_commit_message=PR_BODY), the lines are parsed as real git
 * trailers on the resulting commit.
 */
import { PRODUCT_URL } from '../constants/product.js'
import {
  type AttributionData,
  type AttributionState,
  sanitizeSurfaceKey,
} from './commitAttribution.js'
import { getCanonicalName, getMainLoopModel } from './model/model.js'

/**
 * Derive the number of "steers" for a commit from the session prompt count.
 * The first prompt isn't a steer (it's the initial instruction), so steers =
 * max(prompts - 1, 0).
 */
function steerCountFromPrompts(promptCount: number): number {
  return Math.max(promptCount - 1, 0)
}

/**
 * Format a single commit attribution trailer block.
 *
 * Produces the git-trailer lines that summarize Claude's contribution to a
 * commit: the canonical "Generated with Claude Code" line plus structured
 * machine-readable trailers (percentage, surface, model). Returned as a single
 * newline-joined string so it can be appended to a commit message body.
 *
 * @param data Computed attribution data for the commit.
 * @param modelName Canonical model short name (e.g. "claude-opus-4-5"). Defaults
 *   to the current main-loop model.
 */
export function formatAttributionTrailer(
  data: AttributionData,
  modelName: string = getCanonicalName(getMainLoopModel()),
): string {
  return buildCommitTrailers(data, modelName).join('\n')
}

/**
 * Build the structured trailer lines for a commit from attribution data.
 */
function buildCommitTrailers(
  data: AttributionData,
  modelName: string,
): string[] {
  const lines: string[] = [
    `🤖 Generated with [Claude Code](${PRODUCT_URL})`,
    `Claude-Attribution: ${data.summary.claudePercent}%`,
    `Claude-Model: ${modelName}`,
  ]

  const surfaceKeys = Object.keys(data.surfaceBreakdown)
  if (surfaceKeys.length > 0) {
    const surfaces = surfaceKeys
      .map(key => {
        const { percent } = data.surfaceBreakdown[key]!
        return `${sanitizeSurfaceKey(key)}=${percent}%`
      })
      .join(', ')
    lines.push(`Claude-Surface: ${surfaces}`)
  }

  return lines
}

/**
 * Build the trailer lines appended to a PR body for squash-merge survival.
 *
 * Consumed by getEnhancedPRAttribution() in attribution.ts, which joins the
 * returned lines with newlines and appends them after the human-readable
 * attribution summary. Only invoked for allowlisted internal repos.
 *
 * @param data Computed PR attribution data.
 * @param state Current session attribution state (used for steer count). May be
 *   undefined when no attribution tracking ran.
 */
export function buildPRTrailers(
  data: AttributionData,
  state: AttributionState | undefined,
): string[] {
  const modelName = getCanonicalName(getMainLoopModel())
  const lines = buildCommitTrailers(data, modelName)

  const promptCount = state?.promptCount ?? 0
  if (promptCount > 0) {
    lines.push(`Claude-Steers: ${steerCountFromPrompts(promptCount)}`)
  }

  if (data.sessions.length > 0) {
    lines.push(`Claude-Session: ${data.sessions.join(', ')}`)
  }

  return lines
}
