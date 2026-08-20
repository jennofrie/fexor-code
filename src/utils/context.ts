// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { CONTEXT_1M_BETA_HEADER } from "../constants/betas.js";
import { getGlobalConfig } from "./config.js";
import { isEnvTruthy } from "./envUtils.js";
import { getCanonicalName } from "./model/model.js";
import { getModelCapability } from "./model/modelCapabilities.js";

// Model context window size used when no model-specific capability is known.
export const MODEL_CONTEXT_WINDOW_DEFAULT = 200_000;

export const GPT_5_4_CONTEXT_WINDOW = 1_050_000;

// Maximum output tokens for compact operations
export const COMPACT_MAX_OUTPUT_TOKENS = 20_000;

// Default max output tokens
const MAX_OUTPUT_TOKENS_DEFAULT = 32_000;
const MAX_OUTPUT_TOKENS_UPPER_LIMIT = 64_000;

// Capped default for slot-reservation optimization. BQ p99 output = 4,911
// tokens, so 32k/64k defaults over-reserve 8-16× slot capacity. With the cap
// enabled, <1% of requests hit the limit; those get one clean retry at 64k
// (see query.ts max_output_tokens_escalate). Cap is applied in
// claude.ts:getMaxOutputTokensForModel to avoid the growthbook→betas→context
// import cycle.
export const CAPPED_DEFAULT_MAX_TOKENS = 8_000;
export const ESCALATED_MAX_TOKENS = 64_000;

/**
 * Check if 1M context is disabled via environment variable.
 * Used by C4E admins to disable 1M context for HIPAA compliance.
 */
export function is1mContextDisabled(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT);
}

export function has1mContext(model: string): boolean {
  if (is1mContextDisabled()) {
    return false;
  }
  return /\[1m\]/i.test(model);
}

// @[MODEL LAUNCH]: Update this pattern if the new model supports 1M context
export function modelSupports1M(model: string): boolean {
  if (is1mContextDisabled()) {
    return false;
  }
  const canonical = getCanonicalName(model);
  return (
    canonical.includes("claude-sonnet-5") ||
    canonical.includes("claude-sonnet-4") ||
    canonical.includes("opus-4-6") ||
    canonical.includes("opus-4-8") ||
    isGpt54LongContextModel(model)
  );
}

function isGpt54LongContextModel(model: string): boolean {
  const normalized = model
    .toLowerCase()
    .replace(/\[1m\]$/i, "")
    .trim();
  return normalized === "gpt-5.4" || normalized === "gpt-5.4-pro";
}

function modelHasNative1MContext(model: string): boolean {
  if (is1mContextDisabled()) {
    return false;
  }
  const canonical = getCanonicalName(model);
  return (
    canonical.includes("claude-sonnet-5") ||
    canonical.includes("claude-sonnet-4-6") ||
    canonical.includes("opus-4-8") ||
    canonical.includes("opus-4-7") ||
    canonical.includes("opus-4-6")
  );
}

export function getContextWindowForModel(
  model: string,
  betas?: string[]
): number {
  // Allow override via environment variable.
  // This takes precedence over all other context window resolution, including 1M detection,
  // so launchers can size the effective context window for local decisions (auto-compact,
  // context %) to match a third-party endpoint's TRUE window — e.g. Deepseek V4-Pro / Qwen
  // 3.7-Max native 1M, or GPT-5.5's 400K Codex window — without injecting the Anthropic-only
  // context-1m beta header that the [1m] suffix would. Honored in external builds (this is a
  // purely client-side budgeting value; it is never sent to any provider).
  if (process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS) {
    const override = parseInt(process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, 10);
    if (!isNaN(override) && override > 0) {
      return override;
    }
  }

  // [1m] suffix — explicit client-side opt-in, respected over all detection
  if (has1mContext(model)) {
    return 1_000_000;
  }

  if (!is1mContextDisabled() && isGpt54LongContextModel(model)) {
    return GPT_5_4_CONTEXT_WINDOW;
  }

  if (modelHasNative1MContext(model)) {
    return 1_000_000;
  }

  const cap = getModelCapability(model);
  if (cap?.max_input_tokens && cap.max_input_tokens >= 100_000) {
    if (
      cap.max_input_tokens > MODEL_CONTEXT_WINDOW_DEFAULT &&
      is1mContextDisabled()
    ) {
      return MODEL_CONTEXT_WINDOW_DEFAULT;
    }
    return cap.max_input_tokens;
  }

  if (betas?.includes(CONTEXT_1M_BETA_HEADER) && modelSupports1M(model)) {
    return 1_000_000;
  }
  if (getSonnet1mExpTreatmentEnabled(model)) {
    return 1_000_000;
  }
  if (process.env.USER_TYPE === "ant") {
    const antModel = resolveAntModel(model);
    if (antModel?.contextWindow) {
      return antModel.contextWindow;
    }
  }
  return MODEL_CONTEXT_WINDOW_DEFAULT;
}

export function getSonnet1mExpTreatmentEnabled(model: string): boolean {
  // Obsolete: recent Claude 1M context is generally available (GA) without a beta header.
  // Returning true would inject the retired beta header and trigger legacy credit-check rate limits.
  return false;
}

/**
 * Calculate context window usage percentage from token usage data.
 * Returns used and remaining percentages, or null values if no usage data.
 */
export function calculateContextPercentages(
  currentUsage: {
    input_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  } | null,
  contextWindowSize: number
): { used: number | null; remaining: number | null } {
  if (!currentUsage) {
    return { used: null, remaining: null };
  }

  const totalInputTokens =
    currentUsage.input_tokens +
    currentUsage.cache_creation_input_tokens +
    currentUsage.cache_read_input_tokens;

  const usedPercentage = Math.round(
    (totalInputTokens / contextWindowSize) * 100
  );
  const clampedUsed = Math.min(100, Math.max(0, usedPercentage));

  return {
    used: clampedUsed,
    remaining: 100 - clampedUsed,
  };
}

/**
 * Returns the model's default and upper limit for max output tokens.
 */
export function getModelMaxOutputTokens(model: string): {
  default: number;
  upperLimit: number;
} {
  let defaultTokens: number;
  let upperLimit: number;

  if (process.env.USER_TYPE === "ant") {
    const antModel = resolveAntModel(model.toLowerCase());
    if (antModel) {
      defaultTokens = antModel.defaultMaxTokens ?? MAX_OUTPUT_TOKENS_DEFAULT;
      upperLimit =
        antModel.upperMaxTokensLimit ?? MAX_OUTPUT_TOKENS_UPPER_LIMIT;
      return { default: defaultTokens, upperLimit };
    }
  }

  const m = getCanonicalName(model);

  if (m.includes("deepseek-v4")) {
    // DeepSeek V4 Pro-0813 and Flash-0731 support up to 384K output. Keep the
    // default at 64K to avoid reserving an excessive generation window for
    // ordinary coding turns; launchers can opt in through the env override.
    defaultTokens = 64_000;
    upperLimit = 384_000;
  } else if (m.includes("glm-5.2")) {
    defaultTokens = 64_000;
    upperLimit = 128_000;
  } else if (
    m.includes("sonnet-5") ||
    m.includes("opus-4-8") ||
    m.includes("opus-4-7") ||
    m.includes("opus-4-6")
  ) {
    // Sonnet 5 and Opus 4.6/4.7/4.8 support 128K output. Keep Sonnet's
    // default at 32K to match the existing Sonnet 4.6 budgeting posture.
    defaultTokens = m.includes("sonnet-5") ? 32_000 : 64_000;
    upperLimit = 128_000;
  } else if (m.includes("sonnet-4-6")) {
    defaultTokens = 32_000;
    upperLimit = 128_000;
  } else if (
    m.includes("opus-4-5") ||
    m.includes("sonnet-4") ||
    m.includes("haiku-4")
  ) {
    defaultTokens = 32_000;
    upperLimit = 64_000;
  } else if (m.includes("opus-4-1") || m.includes("opus-4")) {
    defaultTokens = 32_000;
    upperLimit = 32_000;
  } else if (m.includes("claude-3-opus")) {
    defaultTokens = 4_096;
    upperLimit = 4_096;
  } else if (m.includes("claude-3-sonnet")) {
    defaultTokens = 8_192;
    upperLimit = 8_192;
  } else if (m.includes("claude-3-haiku")) {
    defaultTokens = 4_096;
    upperLimit = 4_096;
  } else if (m.includes("3-5-sonnet") || m.includes("3-5-haiku")) {
    defaultTokens = 8_192;
    upperLimit = 8_192;
  } else if (m.includes("3-7-sonnet")) {
    defaultTokens = 32_000;
    upperLimit = 64_000;
  } else {
    defaultTokens = MAX_OUTPUT_TOKENS_DEFAULT;
    upperLimit = MAX_OUTPUT_TOKENS_UPPER_LIMIT;
  }

  const cap = getModelCapability(model);
  if (cap?.max_tokens && cap.max_tokens >= 4_096) {
    upperLimit = cap.max_tokens;
    defaultTokens = Math.min(defaultTokens, upperLimit);
  }

  return { default: defaultTokens, upperLimit };
}

/**
 * Returns the max thinking budget tokens for a given model. The max
 * thinking tokens should be strictly less than the max output tokens.
 *
 * Deprecated since newer models use adaptive thinking rather than a
 * strict thinking token budget.
 */
export function getMaxThinkingTokensForModel(model: string): number {
  return getModelMaxOutputTokens(model).upperLimit - 1;
}
