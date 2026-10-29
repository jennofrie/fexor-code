/**
 * Idle ("sleep") compaction.
 *
 * Ported from the official Claude Code 2.1.312 SleepCompactor. The official
 * implementation arms a timer at 90% of the prompt-cache TTL, applies a
 * remote-only idle-gap clamp plus the SDK exit delay, then enqueues `/compact`
 * only when the conversation is large enough and the cache is still warm.
 *
 * Fexor has no request journal, so cache warmth is derived from the last
 * successful API completion timestamp. The cache TTL defaults to Anthropic's
 * 5-minute window and can be overridden for third-party providers.
 *
 * This stays opt-in: CLAUDE_CODE_SLEEP_COMPACT=1. The official build only
 * installs it on remote hosts; a local harness has to opt in explicitly.
 */

import { getLastApiCompletionTimestamp } from "../../bootstrap/state.js";
import { getGlobalConfig } from "../../utils/config.js";
import { logForDebugging } from "../../utils/debug.js";
import { isEnvTruthy } from "../../utils/envUtils.js";
import { isAutoCompactEnabled } from "./autoCompact.js";

const DEFAULT_CACHE_TTL_MS = 300_000;
const CACHE_FIRE_FRACTION = 0.9;
const EXIT_DELAY_MARGIN_MS = 30_000;

const DEFAULT_AFTER_TURN_MS = 150_000;
const MIN_AFTER_TURN_MS = 60_000;
const MAX_AFTER_TURN_MS = 210_000;
const DEFAULT_MIN_CONTEXT_TOKENS = 150_000;
const MIN_CONTEXT_TOKENS_FLOOR = 60_000;

export type SleepCompactOutcome =
  | "started"
  | "compaction_off"
  | "idle_compaction_off"
  | "stopping"
  | "permission_pending"
  | "busy"
  | "newer_request"
  | "lapsed"
  | "small"
  | "near_limit";

export type SleepCompactEligibility = {
  autoCompactEnabled: boolean;
  idleCompactionEnabled: boolean;
  isStopping: boolean;
  isPermissionPending: boolean;
  isIdle: boolean;
  armedRequestAt: number;
  latestRequestAt: number | null;
  cacheWarm: boolean;
  contextTokens: number;
  minContextTokens: number;
  nearUsageLimit?: boolean;
};

export type SleepCompactFirePlan = {
  cacheActivityAt: number;
  cacheExpiresAt: number;
  lastRequestAt: number;
  turnEndedAt: number;
  afterTurnMs?: number;
  exitDelayMs?: number;
  fireAtFraction?: number;
};

function positiveEnvNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function getSleepCompactAfterTurnMs(): number {
  const configured = positiveEnvNumber(
    "CLAUDE_CODE_SLEEP_COMPACT_AFTER_MS"
  );
  return configured === undefined
    ? DEFAULT_AFTER_TURN_MS
    : clamp(configured, MIN_AFTER_TURN_MS, MAX_AFTER_TURN_MS);
}

export function getSleepCompactMinTokens(): number {
  const configured = positiveEnvNumber(
    "CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS"
  );
  return Math.max(
    MIN_CONTEXT_TOKENS_FLOOR,
    configured ?? DEFAULT_MIN_CONTEXT_TOKENS
  );
}

export function getSleepCompactCacheTtlMs(): number {
  return (
    positiveEnvNumber("CLAUDE_CODE_SLEEP_COMPACT_CACHE_TTL_MS") ??
    DEFAULT_CACHE_TTL_MS
  );
}

/**
 * Earliest safe fire time. Mirrors the official calculation:
 * - 90% of the cache TTL by default;
 * - no later than the turn-end + idle-gap clamp;
 * - when an SDK exit delay is configured, no later than 30s before exit.
 */
export function computeSleepCompactFireAt({
  cacheActivityAt,
  cacheExpiresAt,
  lastRequestAt,
  turnEndedAt,
  afterTurnMs,
  exitDelayMs,
  fireAtFraction = CACHE_FIRE_FRACTION,
}: SleepCompactFirePlan): number {
  const cacheFireAt =
    cacheActivityAt + (cacheExpiresAt - cacheActivityAt) * fireAtFraction;

  if (exitDelayMs === undefined || exitDelayMs <= 0) {
    return afterTurnMs === undefined
      ? cacheFireAt
      : Math.min(cacheFireAt, turnEndedAt + afterTurnMs);
  }

  return Math.min(
    cacheFireAt,
    lastRequestAt + Math.max(0, exitDelayMs - EXIT_DELAY_MARGIN_MS)
  );
}

export function evaluateSleepCompactEligibility({
  autoCompactEnabled,
  idleCompactionEnabled,
  isStopping,
  isPermissionPending,
  isIdle,
  armedRequestAt,
  latestRequestAt,
  cacheWarm,
  contextTokens,
  minContextTokens,
  nearUsageLimit = false,
}: SleepCompactEligibility): SleepCompactOutcome {
  if (!autoCompactEnabled) {
    return "compaction_off";
  }
  if (!idleCompactionEnabled) {
    return "idle_compaction_off";
  }
  if (isStopping) {
    return "stopping";
  }
  if (isPermissionPending) {
    return "permission_pending";
  }
  if (!isIdle) {
    return "busy";
  }
  if (latestRequestAt !== null && latestRequestAt > armedRequestAt) {
    return "newer_request";
  }
  if (!cacheWarm) {
    return "lapsed";
  }
  if (contextTokens < minContextTokens) {
    return "small";
  }
  if (nearUsageLimit) {
    return "near_limit";
  }
  return "started";
}

/** Local builds opt in explicitly; the official gate is remote-host only. */
export function isSleepCompactionHost(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_SLEEP_COMPACT);
}

/** Official `Tn()`: a remote session without a nested environment kind. */
function isRemoteSleepHost(): boolean {
  return (
    process.env.CLAUDE_CODE_REMOTE === "true" &&
    process.env.CLAUDE_CODE_ENVIRONMENT_KIND === undefined
  );
}

function hasConfiguredAfterTurnMs(): boolean {
  const raw = process.env.CLAUDE_CODE_SLEEP_COMPACT_AFTER_MS;
  return raw !== undefined && raw.trim() !== "";
}

export type SleepCompactorOptions = {
  isIdle: () => boolean;
  isStopping: () => boolean;
  isPermissionPending: () => boolean;
  getContextTokens: () => number;
  enqueueCompact: () => void;
  exitDelayMs?: number;
  /** Optional usage-limit guard; omitted when the harness has no quota state. */
  isNearUsageLimit?: () => boolean;
};

export class SleepCompactor {
  #timer: Timer | null = null;
  #handledRequestAt: number | null = null;
  #armedRequestAt: number | null = null;
  #turnEndedAt: number | null = null;
  readonly #options: SleepCompactorOptions;

  constructor(options: SleepCompactorOptions) {
    this.#options = options;
  }

  arm(): void {
    this.cancel();
    try {
      const latestRequestAt = getLastApiCompletionTimestamp();
      if (
        latestRequestAt === null ||
        latestRequestAt === this.#handledRequestAt
      ) {
        return;
      }

      if (latestRequestAt !== this.#armedRequestAt) {
        this.#armedRequestAt = latestRequestAt;
        this.#turnEndedAt = Date.now();
      }

      const cacheTtlMs = getSleepCompactCacheTtlMs();
      // The turn-end clamp is a remote-idle feature in the official build.
      // Locally, default to the cache-TTL fire time unless the operator
      // explicitly configures an idle gap.
      const applyAfterTurnMs =
        this.#options.exitDelayMs === undefined &&
        (isRemoteSleepHost() || hasConfiguredAfterTurnMs());
      const fireAt = computeSleepCompactFireAt({
        cacheActivityAt: latestRequestAt,
        cacheExpiresAt: latestRequestAt + cacheTtlMs,
        lastRequestAt: latestRequestAt,
        turnEndedAt: this.#turnEndedAt ?? Date.now(),
        afterTurnMs: applyAfterTurnMs
          ? getSleepCompactAfterTurnMs()
          : undefined,
        exitDelayMs: this.#options.exitDelayMs,
      });

      this.#timer = setTimeout(
        () => this.#fire(latestRequestAt),
        Math.max(0, fireAt - Date.now()),
        latestRequestAt
      );
      this.#timer.unref?.();
    } catch (error) {
      logForDebugging(`sleep_compact arm failed: ${String(error)}`);
    }
  }

  cancel(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  #fire(armedRequestAt: number): void {
    this.#timer = null;
    try {
      const latestRequestAt = getLastApiCompletionTimestamp();
      const contextTokens = this.#options.getContextTokens();
      const minContextTokens = getSleepCompactMinTokens();
      const cacheTtlMs = getSleepCompactCacheTtlMs();
      const cacheWarm =
        latestRequestAt !== null &&
        Date.now() - latestRequestAt < cacheTtlMs;

      const outcome = evaluateSleepCompactEligibility({
        autoCompactEnabled: isAutoCompactEnabled(),
        idleCompactionEnabled: getGlobalConfig().idleCompaction !== false,
        isStopping: this.#options.isStopping(),
        isPermissionPending: this.#options.isPermissionPending(),
        isIdle: this.#options.isIdle(),
        armedRequestAt,
        latestRequestAt,
        cacheWarm,
        contextTokens,
        minContextTokens,
        nearUsageLimit: this.#options.isNearUsageLimit?.() ?? false,
      });

      logForDebugging(
        `sleep_compact: outcome=${outcome} contextTokens=${contextTokens} minTokens=${minContextTokens}`
      );

      if (
        outcome !== "busy" &&
        outcome !== "permission_pending" &&
        outcome !== "newer_request"
      ) {
        this.#handledRequestAt = armedRequestAt;
      }

      if (outcome === "newer_request") {
        // A background/side-query completion refreshed the cache. Re-arm
        // against it while the session is still idle instead of silently
        // dropping this idle window.
        this.arm();
        return;
      }

      if (outcome === "started") {
        this.#options.enqueueCompact();
      }
    } catch (error) {
      logForDebugging(`sleep_compact fire failed: ${String(error)}`);
    }
  }
}
