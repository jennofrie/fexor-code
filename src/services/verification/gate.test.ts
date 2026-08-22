import { describe, expect, test } from "bun:test";
import {
  resolveVerificationGate,
  shouldEnforceVerificationStopGate,
} from "./gate.js";

describe("resolveVerificationGate", () => {
  test("compile-time feature off always wins", () => {
    expect(
      resolveVerificationGate({
        featureEnabled: false,
        legacyEnabled: true,
        master: true,
      })
    ).toBe(false);
  });

  test.each([
    [false, false],
    [true, true],
  ])("master off preserves legacy=%s", (legacyEnabled, expected) => {
    expect(
      resolveVerificationGate({
        featureEnabled: true,
        legacyEnabled,
        master: false,
        override: "1",
      })
    ).toBe(expected);
  });

  test.each([
    [undefined, true],
    ["1", true],
    ["true", true],
    ["0", false],
    ["false", false],
  ])("master on resolves override=%s", (override, expected) => {
    expect(
      resolveVerificationGate({
        featureEnabled: true,
        legacyEnabled: false,
        master: true,
        override,
      })
    ).toBe(expected);
  });
});

describe("verification stop-gate scope", () => {
  test("enforces only on an enabled main-thread context", () => {
    expect(shouldEnforceVerificationStopGate(true, undefined)).toBeTrue();
    expect(shouldEnforceVerificationStopGate(false, undefined)).toBeFalse();
    expect(shouldEnforceVerificationStopGate(true, "subagent-id")).toBeFalse();
  });
});
