import { describe, expect, test } from "bun:test";
import { shouldExposeLspWhileInitializing } from "./manager.js";

describe("harness LSP startup visibility", () => {
  test("preserves legacy visibility when the harness is off", () => {
    expect(shouldExposeLspWhileInitializing("not-started", false)).toBeFalse();
    expect(shouldExposeLspWhileInitializing("pending", false)).toBeFalse();
  });

  test("keeps the tool visible before and during asynchronous startup", () => {
    expect(shouldExposeLspWhileInitializing("not-started", true)).toBeTrue();
    expect(shouldExposeLspWhileInitializing("pending", true)).toBeTrue();
  });

  test("does not manufacture availability after startup settles", () => {
    expect(shouldExposeLspWhileInitializing("success", true)).toBeFalse();
    expect(shouldExposeLspWhileInitializing("failed", true)).toBeFalse();
  });
});
