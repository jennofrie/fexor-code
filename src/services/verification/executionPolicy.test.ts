import { describe, expect, test } from "bun:test";
import { shouldRunAgentAsynchronously } from "./executionPolicy.js";

const base = {
  mustCompleteBeforeParentContinues: false,
  backgroundTasksDisabled: false,
  requestedBackground: false,
  definitionBackground: false,
  coordinator: false,
  forkSubagent: false,
  assistantMode: false,
  proactive: false,
};

describe("must-complete execution policy", () => {
  for (const forcingInput of [
    "requestedBackground",
    "definitionBackground",
    "coordinator",
    "forkSubagent",
    "assistantMode",
    "proactive",
  ] as const) {
    test(`defeats ${forcingInput}`, () => {
      expect(
        shouldRunAgentAsynchronously({
          ...base,
          [forcingInput]: true,
          mustCompleteBeforeParentContinues: true,
        })
      ).toBeFalse();
    });

    test(`preserves normal ${forcingInput} behavior`, () => {
      expect(
        shouldRunAgentAsynchronously({ ...base, [forcingInput]: true })
      ).toBeTrue();
    });
  }
});
