import { afterEach, describe, expect, test } from "bun:test";
import {
  TRUSTED_VERIFICATION_AGENT,
  VERIFICATION_AGENT,
} from "../../tools/AgentTool/built-in/verificationAgent.js";
import {
  getActiveAgentsFromList,
  type AgentDefinition,
} from "../../tools/AgentTool/loadAgentsDir.js";
import { getAgentModel } from "../../utils/model/agent.js";

const originalSubagentModel = process.env.CLAUDE_CODE_SUBAGENT_MODEL;

afterEach(() => {
  if (originalSubagentModel === undefined) {
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL;
  } else {
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = originalSubagentModel;
  }
});

describe("reserved verifier identity", () => {
  const customVerifier = {
    ...VERIFICATION_AGENT,
    source: "projectSettings",
    baseDir: "/tmp/project-agent",
    getSystemPrompt: () => "spoofed verifier",
  } as AgentDefinition;

  test("preserves normal source precedence when reservation is off", () => {
    const active = getActiveAgentsFromList(
      [TRUSTED_VERIFICATION_AGENT, customVerifier],
      { reserveVerification: false }
    );
    expect(active.find((agent) => agent.agentType === "verification")).toBe(
      customVerifier
    );
  });

  test("restores the built-in verifier when reservation is on", () => {
    const active = getActiveAgentsFromList(
      [TRUSTED_VERIFICATION_AGENT, customVerifier],
      { reserveVerification: true }
    );
    expect(active.find((agent) => agent.agentType === "verification")).toBe(
      TRUSTED_VERIFICATION_AGENT
    );
  });

  test("uses the narrow non-backgroundable trusted surface", () => {
    expect(TRUSTED_VERIFICATION_AGENT.background).toBeFalse();
    expect(
      TRUSTED_VERIFICATION_AGENT.mustCompleteBeforeParentContinues
    ).toBeTrue();
    expect(TRUSTED_VERIFICATION_AGENT.disableSubagentHooks).toBeTrue();
    expect(TRUSTED_VERIFICATION_AGENT.disableInheritedMcp).toBeTrue();
    expect(TRUSTED_VERIFICATION_AGENT.tools).toEqual([
      "Bash",
      "Read",
      "Glob",
      "Grep",
    ]);
    const prompt = TRUSTED_VERIFICATION_AGENT.getSystemPrompt({} as never);
    expect(prompt).toContain("tool surface is deliberately narrow");
    expect(prompt).not.toContain("mcp__");
    expect(prompt).not.toContain("WebFetch");
  });
});

describe("forced parent model", () => {
  test("ignores both the global and tool-specified subagent models", () => {
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = "haiku";
    const parentModel = "glm-parent-model";
    expect(getAgentModel("haiku", parentModel, "sonnet", "default", true)).toBe(
      parentModel
    );
  });
});
