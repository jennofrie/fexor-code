import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  getDefaultEffortForModel,
  modelSupportsEffort,
  modelSupportsMaxEffort,
  resolveAppliedEffort,
} from "./effort.js";

const ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_EFFORT_LEVEL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_OPENAI",
  "CLAUDE_CODE_USE_VERTEX",
  "USER_TYPE",
] as const;

const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  savedEnv.clear();
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("Claude effort defaults", () => {
  test("supports Sonnet 5 effort while preserving the API high default", () => {
    expect(modelSupportsEffort("claude-sonnet-5")).toBe(true);
    expect(modelSupportsMaxEffort("claude-sonnet-5")).toBe(true);
    expect(getDefaultEffortForModel("claude-sonnet-5")).toBeUndefined();
    expect(resolveAppliedEffort("claude-sonnet-5", undefined)).toBeUndefined();
    expect(resolveAppliedEffort("claude-sonnet-5", "max")).toBe("max");
  });

  test("defaults Sonnet 4.6 to max effort", () => {
    expect(getDefaultEffortForModel("claude-sonnet-4-6")).toBe("max");
    expect(resolveAppliedEffort("claude-sonnet-4-6", undefined)).toBe("max");
  });

  test("keeps explicit session effort above the Sonnet 4.6 default", () => {
    expect(resolveAppliedEffort("claude-sonnet-4-6", "medium")).toBe("medium");
  });

  test("supports max effort on Sonnet 4.6", () => {
    expect(modelSupportsEffort("claude-sonnet-4-6")).toBe(true);
    expect(modelSupportsMaxEffort("claude-sonnet-4-6")).toBe(true);
    expect(resolveAppliedEffort("claude-sonnet-4-6", "max")).toBe("max");
  });

  test("supports max effort on DeepSeek V4 launch models", () => {
    expect(modelSupportsEffort("deepseek-v4-pro")).toBe(true);
    expect(modelSupportsMaxEffort("deepseek-v4-pro")).toBe(true);
    expect(resolveAppliedEffort("deepseek-v4-pro", "max")).toBe("max");
  });

  test("supports max effort on GLM 5.2 launch models", () => {
    expect(modelSupportsEffort("glm-5.2[1m]")).toBe(true);
    expect(modelSupportsMaxEffort("glm-5.2[1m]")).toBe(true);
    expect(getDefaultEffortForModel("glm-5.2[1m]")).toBe("max");
    expect(resolveAppliedEffort("glm-5.2[1m]", "max")).toBe("max");
  });

  test("supports max effort on GLM 5.3 launch models", () => {
    expect(modelSupportsEffort("glm-5.3[1m]")).toBe(true);
    expect(modelSupportsMaxEffort("glm-5.3[1m]")).toBe(true);
    expect(getDefaultEffortForModel("glm-5.3[1m]")).toBe("max");
    expect(resolveAppliedEffort("glm-5.3[1m]", "max")).toBe("max");
  });

  test("defaults Opus 4.5 to high effort because the API rejects max", () => {
    const model = "claude-opus-4-5-20251101";
    expect(modelSupportsEffort(model)).toBe(true);
    expect(modelSupportsMaxEffort(model)).toBe(false);
    expect(getDefaultEffortForModel(model)).toBe("high");
    expect(resolveAppliedEffort(model, undefined)).toBe("high");
    expect(resolveAppliedEffort(model, "max")).toBe("high");
  });
});
