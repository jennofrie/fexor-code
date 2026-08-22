import { describe, expect, test } from "bun:test";
import { isCodingHarnessEnabled } from "./gate.js";

describe("coding harness master switch", () => {
  test.each([
    [undefined, false],
    ["", false],
    ["0", false],
    ["false", false],
    ["true", false],
    ["yes", false],
    ["1", true],
  ] as const)("resolves %s to %s", (value, expected) => {
    expect(isCodingHarnessEnabled(value)).toBe(expected);
  });
});
