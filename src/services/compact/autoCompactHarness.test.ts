import { describe, expect, test } from "bun:test";
import { shouldNotifyAutoCompactCircuitBreaker } from "./autoCompact.js";

describe("harness auto-compact circuit-breaker notification", () => {
  test("is silent when the harness is off", () => {
    expect(shouldNotifyAutoCompactCircuitBreaker(3, false)).toBeFalse();
  });

  test("fires exactly when the breaker first trips", () => {
    expect(shouldNotifyAutoCompactCircuitBreaker(2, true)).toBeFalse();
    expect(shouldNotifyAutoCompactCircuitBreaker(3, true)).toBeTrue();
    expect(shouldNotifyAutoCompactCircuitBreaker(4, true)).toBeFalse();
  });
});
