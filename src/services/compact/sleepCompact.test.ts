import { afterEach, describe, expect, test } from "bun:test";
import {
  computeSleepCompactFireAt,
  evaluateSleepCompactEligibility,
  getSleepCompactAfterTurnMs,
  getSleepCompactCacheTtlMs,
  getSleepCompactMinTokens,
} from "./sleepCompact.js";

const baseEligibility = {
  autoCompactEnabled: true,
  idleCompactionEnabled: true,
  isStopping: false,
  isPermissionPending: false,
  isIdle: true,
  armedRequestAt: 1_000,
  latestRequestAt: 1_000,
  cacheWarm: true,
  contextTokens: 200_000,
  minContextTokens: 150_000,
};

afterEach(() => {
  delete process.env.CLAUDE_CODE_SLEEP_COMPACT_AFTER_MS;
  delete process.env.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS;
  delete process.env.CLAUDE_CODE_SLEEP_COMPACT_CACHE_TTL_MS;
});

describe("sleep compaction timing", () => {
  test("fires at 90% of the cache TTL", () => {
    expect(
      computeSleepCompactFireAt({
        cacheActivityAt: 1_000,
        cacheExpiresAt: 301_000,
        lastRequestAt: 1_000,
        turnEndedAt: 2_000,
      })
    ).toBe(271_000);
  });

  test("never waits past the turn-end idle gap", () => {
    expect(
      computeSleepCompactFireAt({
        cacheActivityAt: 1_000,
        cacheExpiresAt: 301_000,
        lastRequestAt: 1_000,
        turnEndedAt: 2_000,
        afterTurnMs: 150_000,
      })
    ).toBe(152_000);
  });

  test("honors an SDK exit delay with a 30s margin", () => {
    expect(
      computeSleepCompactFireAt({
        cacheActivityAt: 1_000,
        cacheExpiresAt: 301_000,
        lastRequestAt: 1_000,
        turnEndedAt: 2_000,
        afterTurnMs: 150_000,
        exitDelayMs: 120_000,
      })
    ).toBe(91_000);
  });

  test("clamps the configurable idle gap to 60s-210s", () => {
    process.env.CLAUDE_CODE_SLEEP_COMPACT_AFTER_MS = "1";
    expect(getSleepCompactAfterTurnMs()).toBe(60_000);
    process.env.CLAUDE_CODE_SLEEP_COMPACT_AFTER_MS = "999999";
    expect(getSleepCompactAfterTurnMs()).toBe(210_000);
  });

  test("uses a 150k-token default floor but never below 60k", () => {
    expect(getSleepCompactMinTokens()).toBe(150_000);
    process.env.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS = "1";
    expect(getSleepCompactMinTokens()).toBe(60_000);
    process.env.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS = "250000";
    expect(getSleepCompactMinTokens()).toBe(250_000);
  });

  test("allows a provider-specific cache TTL override", () => {
    expect(getSleepCompactCacheTtlMs()).toBe(300_000);
    process.env.CLAUDE_CODE_SLEEP_COMPACT_CACHE_TTL_MS = "600000";
    expect(getSleepCompactCacheTtlMs()).toBe(600_000);
  });
});

describe("sleep compaction eligibility", () => {
  test("starts when idle, warm, and large enough", () => {
    expect(evaluateSleepCompactEligibility(baseEligibility)).toBe("started");
  });

  test("respects compaction switches first", () => {
    expect(
      evaluateSleepCompactEligibility({
        ...baseEligibility,
        autoCompactEnabled: false,
      })
    ).toBe("compaction_off");
    expect(
      evaluateSleepCompactEligibility({
        ...baseEligibility,
        idleCompactionEnabled: false,
      })
    ).toBe("idle_compaction_off");
  });

  test("skips stopping, permission, and busy states", () => {
    expect(
      evaluateSleepCompactEligibility({
        ...baseEligibility,
        isStopping: true,
      })
    ).toBe("stopping");
    expect(
      evaluateSleepCompactEligibility({
        ...baseEligibility,
        isPermissionPending: true,
      })
    ).toBe("permission_pending");
    expect(
      evaluateSleepCompactEligibility({
        ...baseEligibility,
        isIdle: false,
      })
    ).toBe("busy");
  });

  test("skips a newer request, a lapsed cache, and small contexts", () => {
    expect(
      evaluateSleepCompactEligibility({
        ...baseEligibility,
        latestRequestAt: 2_000,
      })
    ).toBe("newer_request");
    expect(
      evaluateSleepCompactEligibility({
        ...baseEligibility,
        cacheWarm: false,
      })
    ).toBe("lapsed");
    expect(
      evaluateSleepCompactEligibility({
        ...baseEligibility,
        contextTokens: 149_999,
      })
    ).toBe("small");
  });

  test("skips when usage is near its limit", () => {
    expect(
      evaluateSleepCompactEligibility({
        ...baseEligibility,
        nearUsageLimit: true,
      })
    ).toBe("near_limit");
  });
});
