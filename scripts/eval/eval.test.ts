import { afterEach, describe, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EVAL_CORPUS, getEvalTask } from "./corpus.js";
import { buildSchedule, environmentForArm } from "./config.js";
import { judgeTask, parseChangedPaths } from "./judge.js";
import { writeLockProfile } from "./runner.js";
import { parseStrictVerdict, parseTranscript } from "./transcript.js";
import { runText, stableJson } from "./utils.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("locked evaluation corpus and schedule", () => {
  test("contains the pre-registered 24-task family distribution", () => {
    expect(EVAL_CORPUS).toHaveLength(24);
    const distribution = Object.fromEntries(
      [...new Set(EVAL_CORPUS.map((task) => task.family))].map((family) => [
        family,
        EVAL_CORPUS.filter((task) => task.family === family).length,
      ])
    );
    expect(distribution).toEqual({
      backend: 6,
      frontend: 6,
      cli: 3,
      refactor: 3,
      "malformed-input": 3,
      "rust-lsp": 3,
    });
    expect(new Set(EVAL_CORPUS.map((task) => task.id)).size).toBe(24);
    expect(
      EVAL_CORPUS.filter((task) => task.family === "backend").every((task) =>
        Object.keys(task.files).some((path) => path.startsWith("src/server/"))
      )
    ).toBeTrue();
  });

  test("builds deterministic pilot and Stage B schedules", () => {
    expect(buildSchedule("pilot", 17)).toHaveLength(20);
    expect(buildSchedule("main", 17)).toHaveLength(216);
    expect(buildSchedule("main", 17)).toEqual(buildSchedule("main", 17));
    expect(buildSchedule("main", 17)).not.toEqual(buildSchedule("main", 18));
  });

  test("keeps ablation arms isolated", () => {
    expect(environmentForArm("baseline")).toEqual({
      FEXOR_CODING_HARNESS: "0",
    });
    expect(environmentForArm("verifier-only")).toMatchObject({
      FEXOR_ENABLE_VERIFICATION_AGENT: "1",
      FEXOR_ENABLE_CODING_PROMPT: "0",
      ENABLE_LSP_TOOL: "0",
    });
    expect(environmentForArm("lsp-only")).toMatchObject({
      FEXOR_ENABLE_VERIFICATION_AGENT: "0",
      FEXOR_ENABLE_CODING_PROMPT: "0",
      ENABLE_LSP_TOOL: "1",
    });
    expect(environmentForArm("prompt-only")).toMatchObject({
      FEXOR_ENABLE_VERIFICATION_AGENT: "0",
      FEXOR_ENABLE_CODING_PROMPT: "1",
      ENABLE_LSP_TOOL: "0",
    });
  });

  test("hash serialization retains Error identity without exposing object internals", () => {
    expect(stableJson({ value: new SyntaxError("bad input") })).toContain(
      "SyntaxError"
    );
    expect(stableJson({ value: new SyntaxError("bad input") })).toContain(
      "bad input"
    );
  });
});

describe("transcript metrics", () => {
  test.each([
    ["VERDICT: PASS", "PASS"],
    ["evidence\nVERDICT: FAIL", "FAIL"],
    ["VERDICT: PARTIAL\n", "PARTIAL"],
    ["**VERDICT: PASS**", null],
    ["VERDICT: PASS.", null],
    ["VERDICT: FAIL\nVERDICT: PASS", null],
    ["VERDICT: PASS\nextra", null],
  ] satisfies Array<[string, "PASS" | "FAIL" | "PARTIAL" | null]>)(
    "strictly parses %s",
    (value, expected) => {
      expect(parseStrictVerdict(value)).toBe(expected);
    }
  );

  test("binds a verifier tool result and captures result usage", () => {
    const stdout = [
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "agent-1",
              name: "Agent",
              input: { subagent_type: "verification" },
            },
            { type: "tool_use", id: "lsp-1", name: "LSP", input: {} },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "agent-1",
              content: "checked tests\nVERDICT: PASS",
            },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        num_turns: 7,
        total_cost_usd: 0.25,
        usage: { input_tokens: 100, output_tokens: 40 },
      },
    ]
      .map((value) => JSON.stringify(value))
      .join("\n");
    expect(parseTranscript(stdout)).toEqual({
      verifierInvocations: 1,
      lspToolUses: 1,
      validVerdicts: 1,
      passVerdicts: 1,
      failVerdicts: 0,
      partialVerdicts: 0,
      finalVerdict: "PASS",
      inputTokens: 100,
      outputTokens: 40,
      totalCostUsd: 0.25,
      numTurns: 7,
      resultSubtype: "success",
    });
  });

  test("uses the final bound verdict after a FAIL-fix-PASS sequence", () => {
    const stdout = [
      ["agent-1", "VERDICT: FAIL"],
      ["agent-2", "VERDICT: PASS"],
    ]
      .flatMap(([id, verdict]) => [
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id,
                name: "Agent",
                input: { subagent_type: "verification" },
              },
            ],
          },
        }),
        JSON.stringify({
          type: "user",
          message: {
            content: [
              { type: "tool_result", tool_use_id: id, content: verdict },
            ],
          },
        }),
      ])
      .join("\n");
    const metrics = parseTranscript(stdout);
    expect(metrics.failVerdicts).toBe(1);
    expect(metrics.passVerdicts).toBe(1);
    expect(metrics.finalVerdict).toBe("PASS");
  });

  test("does not retain an earlier PASS after a malformed later attempt", () => {
    const stdout = [
      ["agent-1", "VERDICT: PASS"],
      ["agent-2", "**VERDICT: PASS**"],
    ]
      .flatMap(([id, verdict]) => [
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id,
                name: "Agent",
                input: { subagent_type: "verification" },
              },
            ],
          },
        }),
        JSON.stringify({
          type: "user",
          message: {
            content: [
              { type: "tool_result", tool_use_id: id, content: verdict },
            ],
          },
        }),
      ])
      .join("\n");
    const metrics = parseTranscript(stdout);
    expect(metrics.validVerdicts).toBe(1);
    expect(metrics.finalVerdict).toBeNull();
  });
});

describe("deterministic judge", () => {
  test("parses rename records without losing either path", () => {
    expect(parseChangedPaths("R  new.ts\0old.ts\0?? extra.ts\0")).toEqual([
      "extra.ts",
      "new.ts",
      "old.ts",
    ]);
  });

  test("passes a corrected task using assertions outside the workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "fexor-eval-judge-test-"));
    temporaryRoots.push(workspace);
    const task = getEvalTask("backend-pagination-boundary");
    for (const [path, content] of Object.entries(task.files)) {
      const destination = join(workspace, path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, content);
    }
    const gitEnvironment = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      GIT_AUTHOR_NAME: "Eval",
      GIT_AUTHOR_EMAIL: "eval@example.invalid",
      GIT_COMMITTER_NAME: "Eval",
      GIT_COMMITTER_EMAIL: "eval@example.invalid",
    };
    for (const command of [
      ["git", "init", "--quiet"],
      ["git", "add", "--all"],
      ["git", "commit", "--quiet", "-m", "seed"],
    ]) {
      expect(
        (await runText(command, { cwd: workspace, env: gitEnvironment }))
          .exitCode
      ).toBe(0);
    }
    await writeFile(
      join(workspace, "src/server/pagination.ts"),
      `export function paginate<T>(items: T[], page: number, pageSize: number): T[] {
  if (!Number.isInteger(page) || page < 1) throw new Error('page')
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error('pageSize')
  const start = (page - 1) * pageSize
  return items.slice(start, start + pageSize)
}\n`
    );
    const result = await judgeTask(task, workspace);
    expect(result.passed).toBeTrue();
    expect(result.assertionsFailed).toBe(0);
  });

  test("every seeded task fails its hidden outcome checks before repair", async () => {
    const rustAvailable =
      (await runText(["/usr/bin/env", "sh", "-c", "command -v rustc"]))
        .exitCode === 0;
    const unexpectedlyPassing: string[] = [];
    const infrastructureFailures: string[] = [];
    for (const task of EVAL_CORPUS) {
      if (task.family === "rust-lsp" && !rustAvailable) continue;
      const workspace = await mkdtemp(
        join(tmpdir(), `fexor-eval-seed-${task.id}-`)
      );
      temporaryRoots.push(workspace);
      for (const [path, content] of Object.entries(task.files)) {
        const destination = join(workspace, path);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, content);
      }
      const gitEnvironment = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        GIT_AUTHOR_NAME: "Eval",
        GIT_AUTHOR_EMAIL: "eval@example.invalid",
        GIT_COMMITTER_NAME: "Eval",
        GIT_COMMITTER_EMAIL: "eval@example.invalid",
      };
      for (const command of [
        ["git", "init", "--quiet"],
        ["git", "add", "--all"],
        ["git", "commit", "--quiet", "-m", "seed"],
      ]) {
        expect(
          (await runText(command, { cwd: workspace, env: gitEnvironment }))
            .exitCode
        ).toBe(0);
      }
      const outcome = await judgeTask(task, workspace);
      if (outcome.passed) unexpectedlyPassing.push(task.id);
      if (outcome.infrastructureFailure) {
        infrastructureFailures.push(
          `${task.id}: ${outcome.infrastructureFailure}`
        );
      }
    }
    expect(unexpectedlyPassing).toEqual([]);
    expect(infrastructureFailures).toEqual([]);
  }, 30_000);

  test("candidate checks cannot mutate the workspace or evaluator and receive no API secret", async () => {
    if (process.platform !== "darwin") return;
    const workspace = await mkdtemp(
      join(tmpdir(), "fexor-eval-candidate-lock-")
    );
    temporaryRoots.push(workspace);
    const protectedPath = join(import.meta.dir, "acceptance.json");
    const protectedBefore = await readFile(protectedPath, "utf8");
    const candidatePath = join(workspace, "src/candidate.ts");
    const workspaceTamperPath = join(workspace, "tampered.txt");
    await mkdir(dirname(candidatePath), { recursive: true });
    await writeFile(
      candidatePath,
      `import { readFileSync, writeFileSync } from 'node:fs'\n
for (const path of ${JSON.stringify([protectedPath, workspaceTamperPath])}) {\n
  try { writeFileSync(path, 'tampered') } catch {}\n
}\n
let evaluatorReadable = true\n
try { readFileSync(${JSON.stringify(protectedPath)}) } catch { evaluatorReadable = false }\n
export function inspect() {\n
  return { secret: process.env.GLM_API_KEY ?? null, evaluatorReadable }\n
}\n`
    );
    const gitEnvironment = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      GIT_AUTHOR_NAME: "Eval",
      GIT_AUTHOR_EMAIL: "eval@example.invalid",
      GIT_COMMITTER_NAME: "Eval",
      GIT_COMMITTER_EMAIL: "eval@example.invalid",
    };
    for (const command of [
      ["git", "init", "--quiet"],
      ["git", "add", "--all"],
      ["git", "commit", "--quiet", "-m", "seed"],
    ]) {
      expect(
        (await runText(command, { cwd: workspace, env: gitEnvironment }))
          .exitCode
      ).toBe(0);
    }
    const result = await judgeTask(
      {
        id: "candidate-lock-test",
        family: "backend",
        complexity: "simple",
        prompt: "test",
        files: {},
        allowedPathPrefixes: ["src/"],
        judge: [
          {
            kind: "module-cases",
            modulePath: "src/candidate.ts",
            exportName: "inspect",
            cases: [
              {
                args: [],
                expected: { secret: null, evaluatorReadable: false },
              },
            ],
          },
        ],
      },
      workspace
    );
    expect(result.passed).toBeTrue();
    expect(await readFile(protectedPath, "utf8")).toBe(protectedBefore);
    await expect(lstat(workspaceTamperPath)).rejects.toThrow();
  });

  test("Stage B refuses to start while thresholds are unapproved", async () => {
    const results = await mkdtemp(join(tmpdir(), "fexor-eval-lock-test-"));
    temporaryRoots.push(results);
    const execution = await runText(
      [
        "bun",
        join(import.meta.dir, "runner.ts"),
        "stage-b",
        "--execute",
        "--results-dir",
        results,
      ],
      { cwd: join(import.meta.dir, "../..") }
    );
    expect(execution.exitCode).toBe(1);
    expect(execution.stderr).toContain("Stage B is locked");
  });

  test.skipIf(process.platform !== "darwin")(
    "OS lock permits the task but denies evaluator reads and runtime writes",
    async () => {
      const runtime = await mkdtemp(join(tmpdir(), "fexor-eval-lock-runtime-"));
      const workspace = await mkdtemp(
        join(tmpdir(), "fexor-eval-lock-workspace-")
      );
      temporaryRoots.push(runtime, workspace);
      const workspaceFile = join(workspace, "visible.txt");
      const runtimeProbe = join(runtime, "blocked.txt");
      await writeFile(workspaceFile, "visible");
      const profile = await writeLockProfile(runtime);
      const execution = await runText(
        [
          "/usr/bin/sandbox-exec",
          "-f",
          profile,
          "/bin/sh",
          "-c",
          '/bin/cat "$1" >/dev/null && ! /bin/cat "$2" >/dev/null 2>&1 && ! /usr/bin/touch "$3" 2>/dev/null',
          "locked-eval",
          workspaceFile,
          join(import.meta.dir, "corpus.ts"),
          runtimeProbe,
        ],
        { cwd: workspace }
      );
      expect(execution.exitCode).toBe(0);
    }
  );
});
