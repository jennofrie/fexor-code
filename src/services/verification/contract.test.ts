import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  beginVerificationContractForMessages,
  beginVerificationAttempt,
  clearVerificationContractsForTests,
  fingerprintWorkspace,
  finishVerificationAttempt,
  getVerificationStopDecision,
  isVerificationContractHumanMessage,
  parseVerificationVerdict,
  recordFileMutationOnRecord,
  setVerificationContractForTests,
  type VerificationContractRecord,
  type VerificationVerdict,
} from "./contract.js";
import type { VerificationContextFields } from "./types.js";

const tempRoots: string[] = [];

afterEach(async () => {
  clearVerificationContractsForTests();
  await Promise.all(
    tempRoots.splice(0).map((path) => rm(path, { recursive: true }))
  );
});

async function makeGitWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "fexor-verification-contract-"));
  tempRoots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  await writeFile(join(root, "initial.txt"), "initial\n");
  execFileSync("git", ["add", "initial.txt"], { cwd: root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Fexor Test",
      "-c",
      "user.email=fexor-test@example.invalid",
      "commit",
      "-qm",
      "initial",
    ],
    { cwd: root }
  );
  return root;
}

async function makeRecord(
  overrides: Partial<VerificationContractRecord> = {}
): Promise<VerificationContractRecord> {
  const workspaceRoot = overrides.workspaceRoot ?? (await makeGitWorkspace());
  const fingerprint = await fingerprintWorkspace(workspaceRoot);
  return {
    contractId: "11111111-1111-4111-8111-111111111111",
    sessionKey: "test-session",
    status: "not_required",
    workspaceRoot,
    workspaceRevision: fingerprint.revision,
    attempts: 0,
    stopBlockCount: 0,
    mutatedPaths: [],
    requiredReasons: [],
    degradedNotes: [],
    originalTask: "Fix the seeded bug.",
    amendments: [],
    lastHumanMessageId: "message-1",
    ...overrides,
  };
}

describe("strict verification verdict parser", () => {
  test.each([
    ["evidence\nVERDICT: PASS", "PASS"],
    ["evidence\nVERDICT: FAIL", "FAIL"],
    ["evidence\nVERDICT: PARTIAL", "PARTIAL"],
  ])("accepts one exact terminal verdict", (text, verdict) => {
    expect(parseVerificationVerdict(text)).toEqual({
      ok: true,
      verdict: verdict as VerificationVerdict,
    });
  });

  test.each([
    ["no verdict", "missing_verdict"],
    ["VERDICT: PASS\nextra", "malformed_verdict"],
    ["**VERDICT: PASS**", "missing_verdict"],
    ["VERDICT: PASS.", "malformed_verdict"],
    ["VERDICT: FAIL\nVERDICT: PASS", "multiple_verdicts"],
  ])("rejects %s", (text, reason) => {
    expect(parseVerificationVerdict(text)).toEqual({
      ok: false,
      reason: reason as
        "missing_verdict" | "malformed_verdict" | "multiple_verdicts",
    });
  });
});

describe("contract turn boundary classification", () => {
  test("accepts a real user prompt", () => {
    expect(
      isVerificationContractHumanMessage({
        type: "user",
        uuid: "human",
        message: { content: "implement the feature" },
      })
    ).toBeTrue();
  });

  test("rejects notifications, synthetic summaries, metadata, and tool results", () => {
    expect(
      isVerificationContractHumanMessage({
        type: "user",
        uuid: "notification",
        origin: { kind: "task-notification" },
        message: { content: "agent completed" },
      })
    ).toBeFalse();
    expect(
      isVerificationContractHumanMessage({
        type: "user",
        uuid: "compact",
        isCompactSummary: true,
        isVisibleInTranscriptOnly: true,
        message: { content: "synthetic compact summary" },
      })
    ).toBeFalse();
    expect(
      isVerificationContractHumanMessage({
        type: "user",
        uuid: "coordinator",
        origin: { kind: "coordinator" },
        message: { content: "synthetic coordinator input" },
      })
    ).toBeFalse();
    expect(
      isVerificationContractHumanMessage({
        type: "user",
        uuid: "stop",
        isMeta: true,
        message: { content: "continue verification" },
      })
    ).toBeFalse();
    expect(
      isVerificationContractHumanMessage({
        type: "user",
        uuid: "tool-result",
        message: {
          content: [{ type: "tool_result", tool_use_id: "tool-1" }],
        },
      })
    ).toBeFalse();
  });
});

describe("contract mutation transitions", () => {
  test("binds tool callbacks to the originating contract revision", async () => {
    const workspaceRoot = await makeGitWorkspace();
    const context: VerificationContextFields = {};
    const first = await beginVerificationContractForMessages(
      context,
      [
        {
          type: "user",
          uuid: "human-1",
          origin: { kind: "user" },
          message: { content: "Implement the first change." },
        },
      ],
      "callback-session",
      workspaceRoot
    );
    expect(first).toBeDefined();
    const staleCallback = context.recordVerificationFileMutation;
    expect(staleCallback).toBeFunction();

    const firstPath = join(workspaceRoot, "src/server/first.ts");
    await mkdir(join(workspaceRoot, "src/server"), { recursive: true });
    await writeFile(firstPath, "first\n");
    staleCallback?.(firstPath);
    expect(first?.status).toBe("required");

    if (!first) throw new Error("Expected the first contract.");
    first.status = "pass";
    const second = await beginVerificationContractForMessages(
      context,
      [
        {
          type: "user",
          uuid: "human-2",
          origin: { kind: "user" },
          message: { content: "Implement the second change." },
        },
      ],
      "callback-session",
      workspaceRoot
    );
    expect(second?.contractId).not.toBe(first.contractId);
    expect(second?.status).toBe("not_required");

    staleCallback?.(join(workspaceRoot, "initial.txt"));
    expect(second?.status).toBe("not_required");
    context.recordVerificationOpaqueMutation?.("current opaque write");
    expect(second?.status).toBe("required");
  });

  test("requires verification after three distinct files", async () => {
    const record = await makeRecord();
    recordFileMutationOnRecord(record, join(record.workspaceRoot, "one.ts"));
    recordFileMutationOnRecord(record, join(record.workspaceRoot, "two.ts"));
    expect(record.status).toBe("not_required");
    recordFileMutationOnRecord(record, join(record.workspaceRoot, "three.ts"));
    expect(record.status).toBe("required");
  });

  test("requires verification for one backend path", async () => {
    const record = await makeRecord();
    recordFileMutationOnRecord(
      record,
      join(record.workspaceRoot, "src/server/routes.ts")
    );
    expect(record.status).toBe("required");
  });

  test("fails closed when a native write resolves through a symlink outside the workspace", async () => {
    const record = await makeRecord();
    const externalRoot = await mkdtemp(
      join(tmpdir(), "fexor-verification-external-")
    );
    tempRoots.push(externalRoot);
    const externalPath = join(externalRoot, "outside.ts");
    const linkedPath = join(record.workspaceRoot, "linked.ts");
    await writeFile(externalPath, "outside\n");
    await symlink(externalPath, linkedPath);

    recordFileMutationOnRecord(record, linkedPath);

    expect(record.status).toBe("unverified_error");
    expect(record.requiredReasons.join("\n")).toContain(externalPath);
  });

  test("edit after PASS invalidates the verdict and resets attempts", async () => {
    const record = await makeRecord({ status: "pass", attempts: 2 });
    recordFileMutationOnRecord(record, join(record.workspaceRoot, "src/ui.ts"));
    expect(record.status).toBe("required");
    expect(record.attempts).toBe(0);
    expect(record.verifiedRevision).toBeUndefined();
  });

  test("a fix after FAIL returns to required and resets the revision budget", async () => {
    const record = await makeRecord({ status: "fail", attempts: 2 });
    recordFileMutationOnRecord(record, join(record.workspaceRoot, "src/ui.ts"));
    expect(record.status).toBe("required");
    expect(record.attempts).toBe(0);
    expect(record.requiredReasons.join("\n")).toContain(
      "Implementation changed after a failed verification attempt."
    );
  });

  test("does not misclassify one low-risk native edit as an opaque write", async () => {
    const record = await makeRecord();
    const baseline = await fingerprintWorkspace(record.workspaceRoot);
    setVerificationContractForTests(record, baseline.pathStates);
    const path = join(record.workspaceRoot, "initial.txt");
    recordFileMutationOnRecord(record, path);
    await writeFile(path, "native edit\n");

    const decision = await getVerificationStopDecision({
      verificationContractId: record.contractId,
    });
    expect(decision.action).toBe("allow");
    expect(record.status).toBe("not_required");
  });

  test("requires verification for an unrecorded external edit", async () => {
    const record = await makeRecord();
    const baseline = await fingerprintWorkspace(record.workspaceRoot);
    setVerificationContractForTests(record, baseline.pathStates);
    await writeFile(join(record.workspaceRoot, "external.txt"), "external\n");

    const decision = await getVerificationStopDecision({
      verificationContractId: record.contractId,
    });
    expect(decision.action).toBe("block");
    expect(record.requiredReasons.join("\n")).toContain("external.txt");
  });
});

describe("revision-bound attempts", () => {
  test("rejects duplicate verifier spawn while running", async () => {
    const record = await makeRecord({ status: "required" });
    setVerificationContractForTests(record);
    const context = { verificationContractId: record.contractId };
    await beginVerificationAttempt(context, "task-1", "");
    await expect(
      beginVerificationAttempt(context, "task-2", "")
    ).rejects.toThrow("already running");
  });

  test("ignores a result from a stale task id", async () => {
    const record = await makeRecord({ status: "required" });
    setVerificationContractForTests(record);
    const context = { verificationContractId: record.contractId };
    const attempt = await beginVerificationAttempt(context, "task-current", "");
    const result = await finishVerificationAttempt({
      toolUseContext: context,
      taskId: "task-old",
      boundWorkspaceRevision: attempt.revision,
      snapshotBeforeRevision: attempt.revision,
      snapshotAfterRevision: attempt.revision,
      finalText: "VERDICT: PASS",
      evidenceToolUses: 1,
    });
    expect(result).toBeUndefined();
    expect(record.status).toBe("running");
  });

  test("accepts PASS only for the exact unchanged revision with evidence", async () => {
    const record = await makeRecord({ status: "required" });
    setVerificationContractForTests(record);
    const context = { verificationContractId: record.contractId };
    const attempt = await beginVerificationAttempt(context, "task-1", "");
    await finishVerificationAttempt({
      toolUseContext: context,
      taskId: "task-1",
      boundWorkspaceRevision: attempt.revision,
      snapshotBeforeRevision: attempt.revision,
      snapshotAfterRevision: attempt.revision,
      finalText: "command output\nVERDICT: PASS",
      evidenceToolUses: 1,
    });
    expect(record.status).toBe("pass");
    expect(record.verifiedRevision).toBe(attempt.revision);
  });

  test("fails closed when PASS has no executable evidence", async () => {
    const record = await makeRecord({ status: "required" });
    setVerificationContractForTests(record);
    const context = { verificationContractId: record.contractId };
    const attempt = await beginVerificationAttempt(context, "task-1", "");
    await finishVerificationAttempt({
      toolUseContext: context,
      taskId: "task-1",
      boundWorkspaceRevision: attempt.revision,
      snapshotBeforeRevision: attempt.revision,
      snapshotAfterRevision: attempt.revision,
      finalText: "VERDICT: PASS",
      evidenceToolUses: 0,
    });
    expect(record.status).toBe("unverified_error");
  });

  test("ignores a verdict when the main workspace changed during verification", async () => {
    const record = await makeRecord({ status: "required" });
    setVerificationContractForTests(record);
    const context = { verificationContractId: record.contractId };
    const attempt = await beginVerificationAttempt(context, "task-1", "");
    await writeFile(
      join(record.workspaceRoot, "changed-during-run.txt"),
      "new\n"
    );
    await finishVerificationAttempt({
      toolUseContext: context,
      taskId: "task-1",
      boundWorkspaceRevision: attempt.revision,
      snapshotBeforeRevision: attempt.revision,
      snapshotAfterRevision: attempt.revision,
      finalText: "command output\nVERDICT: PASS",
      evidenceToolUses: 1,
    });
    expect(record.status).toBe("required");
    expect(record.verifiedRevision).toBeUndefined();
    expect(record.requiredReasons.join("\n")).toContain("verdict was stale");
  });

  test("rejects a verdict when the verifier mutates revision-bound snapshot content", async () => {
    const record = await makeRecord({ status: "required" });
    setVerificationContractForTests(record);
    const context = { verificationContractId: record.contractId };
    const attempt = await beginVerificationAttempt(context, "task-1", "");
    await finishVerificationAttempt({
      toolUseContext: context,
      taskId: "task-1",
      boundWorkspaceRevision: attempt.revision,
      snapshotBeforeRevision: "snapshot-before",
      snapshotAfterRevision: "snapshot-after",
      finalText: "command output\nVERDICT: PASS",
      evidenceToolUses: 1,
    });
    expect(record.status).toBe("unverified_error");
    expect(record.terminalReason).toContain("Verifier changed");
  });

  test("caps repeated attempts for the same workspace revision", async () => {
    const record = await makeRecord({ status: "required" });
    setVerificationContractForTests(record);
    const context = { verificationContractId: record.contractId };
    for (let attemptIndex = 1; attemptIndex <= 3; attemptIndex += 1) {
      const attempt = await beginVerificationAttempt(
        context,
        `task-${attemptIndex}`,
        ""
      );
      await finishVerificationAttempt({
        toolUseContext: context,
        taskId: `task-${attemptIndex}`,
        boundWorkspaceRevision: attempt.revision,
        snapshotBeforeRevision: attempt.revision,
        snapshotAfterRevision: attempt.revision,
        finalText: "failing check\nVERDICT: FAIL",
        evidenceToolUses: 1,
      });
    }
    await expect(
      beginVerificationAttempt(context, "task-4", "")
    ).rejects.toThrow("Maximum verification attempts");
    expect(record.status).toBe("unverified_error");
  });

  test("PARTIAL terminates unverified instead of releasing as success", async () => {
    const record = await makeRecord({ status: "partial" });
    setVerificationContractForTests(record);
    const decision = await getVerificationStopDecision({
      verificationContractId: record.contractId,
    });
    expect(decision.action).toBe("terminal_unverified");
  });

  test.each([
    ["not_required", "allow"],
    ["pass", "allow"],
    ["waived", "allow"],
    ["required", "block"],
    ["fail", "block"],
    ["partial", "terminal_unverified"],
    ["unverified_error", "terminal_unverified"],
    ["running", "terminal_unverified"],
  ] as const)(
    "maps %s to the bounded stop action %s",
    async (status, action) => {
      const record = await makeRecord({ status });
      setVerificationContractForTests(record);
      expect(
        (
          await getVerificationStopDecision({
            verificationContractId: record.contractId,
          })
        ).action
      ).toBe(action);
    }
  );
});
