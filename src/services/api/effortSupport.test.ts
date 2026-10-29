import { afterEach, describe, expect, test } from "bun:test";
import {
  isEffortUnsupportedForModel,
  isEffortUnsupportedMessage,
  markEffortUnsupportedForModel,
  resetEffortUnsupportedForTests,
} from "./effortSupport.js";

afterEach(() => {
  resetEffortUnsupportedForTests();
});

describe("effort rejection classifier", () => {
  test("recognizes explicit effort rejections", () => {
    expect(
      isEffortUnsupportedMessage(
        400,
        "This model does not support the effort parameter"
      )
    ).toBe(true);
    expect(
      isEffortUnsupportedMessage(400, "output_config: Extra inputs are not permitted")
    ).toBe(true);
    expect(
      isEffortUnsupportedMessage(
        422,
        "requires a model that supports output_config.effort"
      )
    ).toBe(true);
  });

  test("does not confuse structured outputs or task budgets with effort", () => {
    expect(
      isEffortUnsupportedMessage(
        400,
        "output_config.format: Extra inputs are not permitted"
      )
    ).toBe(false);
    expect(
      isEffortUnsupportedMessage(
        400,
        "output_config.task_budget: Extra inputs are not permitted"
      )
    ).toBe(false);
  });

  test("ignores other errors", () => {
    expect(isEffortUnsupportedMessage(500, "effort overloaded")).toBe(false);
    expect(isEffortUnsupportedMessage(400, "prompt is too long")).toBe(false);
  });
});

describe("effort support latch", () => {
  test("latches a model case-insensitively", () => {
    expect(isEffortUnsupportedForModel("DeepSeek-Flash[1m]")).toBe(false);
    markEffortUnsupportedForModel("deepseek-flash[1m]");
    expect(isEffortUnsupportedForModel("DeepSeek-Flash[1m]")).toBe(true);
    expect(isEffortUnsupportedForModel("deepseek-v4-pro")).toBe(false);
  });
});
