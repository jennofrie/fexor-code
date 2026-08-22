#!/usr/bin/env bun
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { EVAL_CORPUS, getEvalTask } from "./corpus.js";
import { buildSchedule, environmentForArm } from "./config.js";
import { judgeTask } from "./judge.js";
import { generateReport } from "./report.js";
import { parseTranscript } from "./transcript.js";
import type {
  AcceptanceThresholds,
  EvalManifest,
  EvalRunRecord,
  EvalScheduleEntry,
} from "./types.js";
import {
  appendPrivateJsonLine,
  hashFile,
  redactOutput,
  runText,
  sensitiveEnvironmentValues,
  sha256,
  stableJson,
  writePrivateFile,
} from "./utils.js";

const repositoryRoot = resolve(import.meta.dir, "../..");
const acceptancePath = join(import.meta.dir, "acceptance.json");
const canonicalReportPath = join(import.meta.dir, "REPORT.md");
const sourceHashPaths = [
  "src",
  "scripts",
  "prompts",
  "docs",
  "launch-glm.sh",
  "package.json",
  "bun.lock",
  ":(exclude)scripts/eval/REPORT.md",
  ":(exclude)scripts/eval/results/**",
];

type Stage = "pilot" | "main";
type RunnerOptions = {
  command: "plan" | "pilot" | "stage-b" | "report";
  execute: boolean;
  model: string;
  effort: string;
  seed: number;
  timeoutMs: number;
  maxTurns: number;
  taskBudgetTokens: number;
  maxBudgetUsd: number;
  resultsDirectory: string;
};

function flagValue(args: string[], name: string): string | undefined {
  const equals = args.find((value) => value.startsWith(`${name}=`));
  if (equals) return equals.slice(name.length + 1);
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function positiveNumber(
  raw: string | undefined,
  fallback: number,
  name: string
): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0)
    throw new Error(`${name} must be positive`);
  return parsed;
}

function parseOptions(args: string[]): RunnerOptions {
  const command = (args[0] ?? "plan") as RunnerOptions["command"];
  if (!["plan", "pilot", "stage-b", "report"].includes(command)) {
    throw new Error(
      `Unknown command ${command}; use plan, pilot, stage-b, or report`
    );
  }
  const defaultStage = command === "pilot" ? "pilot" : "main";
  const defaultResults = join(import.meta.dir, "results", defaultStage);
  return {
    command,
    execute: args.includes("--execute"),
    model: flagValue(args, "--model") ?? "glm-5.3[1m]",
    effort: flagValue(args, "--effort") ?? "max",
    seed: Math.floor(
      positiveNumber(flagValue(args, "--seed"), 20260821, "--seed")
    ),
    timeoutMs: Math.floor(
      positiveNumber(flagValue(args, "--timeout-ms"), 600_000, "--timeout-ms")
    ),
    maxTurns: Math.floor(
      positiveNumber(flagValue(args, "--max-turns"), 30, "--max-turns")
    ),
    taskBudgetTokens: Math.floor(
      positiveNumber(flagValue(args, "--task-budget"), 100_000, "--task-budget")
    ),
    maxBudgetUsd: positiveNumber(
      flagValue(args, "--max-budget-usd"),
      2,
      "--max-budget-usd"
    ),
    resultsDirectory: resolve(
      flagValue(args, "--results-dir") ?? defaultResults
    ),
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function loadAcceptance(): Promise<AcceptanceThresholds> {
  const value = JSON.parse(
    await readFile(acceptancePath, "utf8")
  ) as AcceptanceThresholds;
  const numericKeys: Array<keyof AcceptanceThresholds> = [
    "minimumSuccessDeltaPercentagePoints",
    "maximumFalsePassRate",
    "maximumCostMultiplier",
    "maximumInfraFailureRate",
    "maximumBudgetUsdPerRun",
  ];
  for (const key of numericKeys) {
    if (
      typeof value[key] !== "number" ||
      !Number.isFinite(value[key] as number)
    ) {
      throw new Error(`Invalid acceptance threshold ${key}`);
    }
  }
  if (
    value.approved &&
    (!value.approvedBy.trim() || !value.approvedAt.trim())
  ) {
    throw new Error("Approved thresholds require approvedBy and approvedAt");
  }
  if (
    value.minimumSuccessDeltaPercentagePoints < -100 ||
    value.minimumSuccessDeltaPercentagePoints > 100 ||
    value.maximumFalsePassRate < 0 ||
    value.maximumFalsePassRate > 1 ||
    value.maximumInfraFailureRate < 0 ||
    value.maximumInfraFailureRate > 1 ||
    value.maximumCostMultiplier <= 0 ||
    value.maximumBudgetUsdPerRun <= 0
  ) {
    throw new Error("Acceptance thresholds are outside their valid ranges");
  }
  return value;
}

async function hashSourceState(): Promise<string> {
  const diff = await runText(
    ["git", "diff", "--binary", "HEAD", "--", ...sourceHashPaths],
    { cwd: repositoryRoot }
  );
  if (diff.exitCode !== 0)
    throw new Error(`Unable to hash source diff: ${diff.stderr}`);
  const untracked = await runText(
    [
      "git",
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      ...sourceHashPaths,
    ],
    { cwd: repositoryRoot }
  );
  if (untracked.exitCode !== 0) {
    throw new Error(
      `Unable to enumerate untracked source: ${untracked.stderr}`
    );
  }
  const parts = [diff.stdout];
  for (const path of untracked.stdout.split("\0").filter(Boolean).sort()) {
    const absolutePath = resolve(repositoryRoot, path);
    const metadata = await lstat(absolutePath);
    if (metadata.isSymbolicLink()) {
      parts.push(`symlink:${path}:${await readlink(absolutePath)}`);
    } else if (metadata.isFile()) {
      parts.push(
        `file:${path}:${metadata.mode & 0o777}:${sha256(await readFile(absolutePath))}`
      );
    }
  }
  return sha256(parts.join("\0"));
}

async function hashFiles(paths: string[]): Promise<string> {
  const parts: string[] = [];
  for (const path of paths)
    parts.push(`${relative(repositoryRoot, path)}:${await hashFile(path)}`);
  return sha256(parts.join("\n"));
}

async function installedPluginVersion(): Promise<string | null> {
  const pluginRoot = join(
    homedir(),
    ".fexor-code-glm/plugins/cache/claude-plugins-official/rust-analyzer-lsp"
  );
  try {
    return (await readdir(pluginRoot)).sort().at(-1) ?? null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function keychainRedactionSecrets(): Promise<string[]> {
  if (process.platform !== "darwin") return [];
  const values: string[] = [];
  for (const service of ["glm_api_key", "zai_api_key"]) {
    const result = await runText(
      ["/usr/bin/security", "find-generic-password", "-s", service, "-w"],
      {
        env: {
          PATH: "/usr/bin:/bin",
          HOME: homedir(),
        },
      }
    );
    const value = result.exitCode === 0 ? result.stdout.trim() : "";
    if (value.length >= 4) values.push(value);
  }
  return values;
}

function baseChildEnvironment(): Record<string, string> {
  const names = [
    "HOME",
    "PATH",
    "TMPDIR",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LC_ALL",
    "GLM_API_KEY",
    "ZAI_API_KEY",
    "Z_AI_API_KEY",
    "GLM_BASE_URL",
  ];
  const environment: Record<string, string> = {};
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  environment.CI = "1";
  environment.NO_COLOR = "1";
  return environment;
}

async function prepareManifest(
  stage: Stage,
  options: RunnerOptions,
  schedule: EvalScheduleEntry[],
  childEnvironment: Record<string, string>
): Promise<{ manifest: EvalManifest; manifestHash: string }> {
  const thresholds = stage === "main" ? await loadAcceptance() : null;
  if (stage === "main" && !thresholds?.approved) {
    throw new Error(
      "Stage B is locked: review scripts/eval/acceptance.json with the user and set approved=true before execution."
    );
  }
  if (thresholds && options.maxBudgetUsd > thresholds.maximumBudgetUsdPerRun) {
    throw new Error(
      `--max-budget-usd ${options.maxBudgetUsd} exceeds the approved per-run cap ${thresholds.maximumBudgetUsdPerRun}`
    );
  }

  const manifest: EvalManifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    stage,
    corpusHash: sha256(stableJson(EVAL_CORPUS)),
    binaryHash: await hashFile(join(repositoryRoot, "cli-dev")),
    sourceDiffHash: await hashSourceState(),
    judgeHash: await hashFiles([
      join(import.meta.dir, "judge.ts"),
      join(import.meta.dir, "transcript.ts"),
    ]),
    runnerHash: await hashFiles([
      join(import.meta.dir, "runner.ts"),
      join(import.meta.dir, "config.ts"),
      join(import.meta.dir, "report.ts"),
      join(import.meta.dir, "utils.ts"),
    ]),
    model: options.model,
    effort: options.effort,
    pluginVersion: await installedPluginVersion(),
    taskIds: [...new Set(schedule.map((entry) => entry.taskId))].sort(),
    arms: [...new Set(schedule.map((entry) => entry.arm))].sort(),
    repetitions: stage === "main" ? 3 : 1,
    seed: options.seed,
    timeoutMs: options.timeoutMs,
    maxTurns: options.maxTurns,
    taskBudgetTokens: options.taskBudgetTokens,
    maxBudgetUsd: options.maxBudgetUsd,
    environmentVariableNames: [
      ...new Set([
        ...Object.keys(childEnvironment),
        ...schedule.flatMap((entry) =>
          Object.keys(environmentForArm(entry.arm))
        ),
      ]),
    ].sort(),
    thresholds,
  };

  await mkdir(options.resultsDirectory, { recursive: true, mode: 0o700 });
  const manifestPath = join(options.resultsDirectory, "manifest.json");
  if (await pathExists(manifestPath)) {
    const existingText = await readFile(manifestPath, "utf8");
    const existing = JSON.parse(existingText) as EvalManifest;
    const { createdAt: _existingCreated, ...existingStable } = existing;
    const { createdAt: _newCreated, ...newStable } = manifest;
    if (stableJson(existingStable) !== stableJson(newStable)) {
      throw new Error(
        `Existing manifest at ${manifestPath} is immutable and does not match this run; select a new --results-dir.`
      );
    }
    return { manifest: existing, manifestHash: sha256(existingText) };
  }
  const text = `${stableJson(manifest)}\n`;
  await writeFile(manifestPath, text, { mode: 0o600, flag: "wx" });
  return { manifest, manifestHash: sha256(text) };
}

async function stageRuntime(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "fexor-eval-runtime-"));
  await mkdir(join(root, "prompts"), { mode: 0o700 });
  for (const path of ["cli-dev", "launch-glm.sh"]) {
    await copyFile(join(repositoryRoot, path), join(root, path));
  }
  for (const path of [
    "glm-autonomy-system-prompt.md",
    "glm-coding-harness-prompt.md",
    "harness-lsp-settings.json",
  ]) {
    await copyFile(
      join(repositoryRoot, "prompts", path),
      join(root, "prompts", path)
    );
  }
  await chmod(join(root, "cli-dev"), 0o755);
  await chmod(join(root, "launch-glm.sh"), 0o755);
  return root;
}

function sandboxString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export async function writeLockProfile(runtimeRoot: string): Promise<string> {
  const profile = join(runtimeRoot, "locked-eval.sb");
  const [canonicalRepositoryRoot, canonicalRuntimeRoot] = await Promise.all([
    realpath(repositoryRoot),
    realpath(runtimeRoot),
  ]);
  await writeFile(
    profile,
    `(version 1)\n(deny file-read* file-write* (subpath ${sandboxString(canonicalRepositoryRoot)}))\n(deny file-write* (subpath ${sandboxString(canonicalRuntimeRoot)}))\n(allow default)\n`,
    { mode: 0o600 }
  );
  return profile;
}

async function materializeTask(
  entry: EvalScheduleEntry
): Promise<{ workspace: string; cleanup: () => Promise<void> }> {
  const task = getEvalTask(entry.taskId);
  const workspace = await mkdtemp(join(tmpdir(), `fexor-eval-${task.id}-`));
  for (const [path, content] of Object.entries(task.files)) {
    const destination = resolve(workspace, path);
    if (!destination.startsWith(`${workspace}/`)) {
      throw new Error(`Task path escapes workspace: ${path}`);
    }
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, content, { mode: 0o600 });
  }
  const gitEnvironment = {
    ...baseChildEnvironment(),
    GIT_AUTHOR_NAME: "Fexor Eval",
    GIT_AUTHOR_EMAIL: "eval.invalid@example.invalid",
    GIT_COMMITTER_NAME: "Fexor Eval",
    GIT_COMMITTER_EMAIL: "eval.invalid@example.invalid",
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  };
  for (const command of [
    ["git", "init", "--quiet"],
    ["git", "add", "--all"],
    ["git", "commit", "--quiet", "-m", "Seed locked evaluation task"],
  ]) {
    const execution = await runText(command, {
      cwd: workspace,
      env: gitEnvironment,
    });
    if (execution.exitCode !== 0) {
      await rm(workspace, { recursive: true, force: true });
      throw new Error(
        `Failed to initialize evaluation workspace: ${execution.stderr}`
      );
    }
  }
  return {
    workspace,
    cleanup: () => rm(workspace, { recursive: true, force: true }),
  };
}

async function captureProcess(
  command: string[],
  cwd: string,
  environment: Record<string, string>,
  timeoutMs: number
): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}> {
  const child = Bun.spawn(command, {
    cwd,
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

async function buildLaunchCommand(
  runtimeRoot: string,
  sandboxProfile: string,
  taskPrompt: string,
  options: RunnerOptions
): Promise<string[]> {
  const harnessCommand = [
    "/usr/bin/sandbox-exec",
    "-f",
    sandboxProfile,
    join(runtimeRoot, "launch-glm.sh"),
    "-p",
    taskPrompt,
    "--output-format",
    "stream-json",
    "--dangerously-skip-permissions",
    "--max-turns",
    String(options.maxTurns),
    "--task-budget",
    String(options.taskBudgetTokens),
    "--max-budget-usd",
    String(options.maxBudgetUsd),
    "--model",
    options.model,
    "--effort",
    options.effort,
  ];
  const environmentFile = join(repositoryRoot, ".env.glm");
  if (!(await pathExists(environmentFile))) return harnessCommand;
  const varlock = Bun.which("varlock");
  if (!varlock) {
    throw new Error(
      "A .env.glm exists, but Varlock is unavailable for safe injection"
    );
  }
  return [
    varlock,
    "run",
    "--redact-stdout",
    "--inject",
    "vars",
    "--filter",
    "GLM_*,ZAI_API_KEY,Z_AI_API_KEY",
    "--path",
    environmentFile,
    "--",
    ...harnessCommand,
  ];
}

async function workspaceDiff(workspace: string): Promise<string> {
  const [status, diff] = await Promise.all([
    runText(["git", "status", "--short", "--untracked-files=all"], {
      cwd: workspace,
    }),
    runText(["git", "diff", "--binary", "--no-ext-diff", "HEAD"], {
      cwd: workspace,
    }),
  ]);
  return `STATUS\n${status.stdout}\nDIFF\n${diff.stdout}`;
}

function infrastructureReason(
  execution: { exitCode: number | null; timedOut: boolean },
  resultSubtype: string | null,
  judgeInfrastructureFailure?: string
): string | undefined {
  if (execution.timedOut) return "harness process timed out";
  if (judgeInfrastructureFailure) return judgeInfrastructureFailure;
  if (execution.exitCode === null)
    return "harness process did not return an exit code";
  if (resultSubtype === null) return "stream-json result record missing";
  if (resultSubtype === "error_during_execution")
    return "harness execution error";
  return undefined;
}

async function executeEntry(
  entry: EvalScheduleEntry,
  retry: number,
  options: RunnerOptions,
  runtimeRoot: string,
  sandboxProfile: string,
  manifestHash: string,
  childEnvironment: Record<string, string>,
  secretValues: string[]
): Promise<EvalRunRecord> {
  const task = getEvalTask(entry.taskId);
  const runId = `${task.id}--${entry.arm}--r${entry.repetition}`;
  const artifactStem = `${runId}--attempt${retry + 1}`;
  const artifactsDirectory = join(options.resultsDirectory, "artifacts");
  const stdoutPath = join(artifactsDirectory, `${artifactStem}.stdout.jsonl`);
  const stderrPath = join(artifactsDirectory, `${artifactStem}.stderr.txt`);
  const diffPath = join(artifactsDirectory, `${artifactStem}.diff.txt`);
  const { workspace, cleanup } = await materializeTask(entry);
  const startedAt = new Date().toISOString();
  const start = performance.now();
  try {
    const command = await buildLaunchCommand(
      runtimeRoot,
      sandboxProfile,
      task.prompt,
      options
    );
    const execution = await captureProcess(
      command,
      workspace,
      { ...childEnvironment, ...environmentForArm(entry.arm) },
      options.timeoutMs
    );
    const durationMs = Math.round(performance.now() - start);
    const transcript = parseTranscript(execution.stdout);
    const judge = await judgeTask(task, workspace);
    const infraReason = infrastructureReason(
      execution,
      transcript.resultSubtype,
      judge.infrastructureFailure
    );
    const [safeStdout, safeStderr, safeDiff] = [
      execution.stdout,
      execution.stderr,
      await workspaceDiff(workspace),
    ].map((value) => redactOutput(value, secretValues));
    await Promise.all([
      writePrivateFile(stdoutPath, safeStdout),
      writePrivateFile(stderrPath, safeStderr),
      writePrivateFile(diffPath, safeDiff),
    ]);
    return {
      schemaVersion: 1,
      runId,
      manifestHash,
      taskId: task.id,
      family: task.family,
      complexity: task.complexity,
      arm: entry.arm,
      repetition: entry.repetition,
      startedAt,
      durationMs,
      processExitCode: execution.exitCode,
      timedOut: execution.timedOut,
      infraFailure: infraReason !== undefined,
      infraReason,
      discarded: infraReason !== undefined,
      retry,
      judge,
      transcript,
      falsePass: transcript.finalVerdict === "PASS" && !judge.passed,
      falseFail: transcript.finalVerdict === "FAIL" && judge.passed,
      falsePartial: transcript.finalVerdict === "PARTIAL" && judge.passed,
      stdoutArtifact: relative(options.resultsDirectory, stdoutPath),
      stderrArtifact: relative(options.resultsDirectory, stderrPath),
      diffArtifact: relative(options.resultsDirectory, diffPath),
    };
  } finally {
    await cleanup();
  }
}

async function readCompletedKeys(
  resultsDirectory: string
): Promise<Set<string>> {
  try {
    const lines = (await readFile(join(resultsDirectory, "runs.jsonl"), "utf8"))
      .split(/\r?\n/u)
      .filter(Boolean);
    return new Set(
      lines
        .map((line) => JSON.parse(line) as EvalRunRecord)
        .filter((record) => !record.discarded && !record.infraFailure)
        .map((record) => record.runId)
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw error;
  }
}

async function runStage(stage: Stage, options: RunnerOptions): Promise<void> {
  if (!options.execute) {
    throw new Error(
      `${stage === "pilot" ? "Pilot" : "Stage B"} is dry-run by default; add --execute after reviewing cost and configuration.`
    );
  }
  if (
    process.platform !== "darwin" ||
    !(await pathExists("/usr/bin/sandbox-exec"))
  ) {
    throw new Error("Locked evaluation currently requires macOS sandbox-exec");
  }
  if (!(await pathExists(join(repositoryRoot, "cli-dev")))) {
    throw new Error("cli-dev is missing; run bun run build:dev:full first");
  }
  const schedule = buildSchedule(stage, options.seed);
  const childEnvironment = baseChildEnvironment();
  const { manifestHash } = await prepareManifest(
    stage,
    options,
    schedule,
    childEnvironment
  );
  const completed = await readCompletedKeys(options.resultsDirectory);
  const runtimeRoot = await stageRuntime();
  const secretValues = [
    ...new Set([
      ...sensitiveEnvironmentValues(process.env),
      ...(await keychainRedactionSecrets()),
    ]),
  ].sort((left, right) => right.length - left.length);
  let exhaustedInfrastructureRuns = 0;
  try {
    const sandboxProfile = await writeLockProfile(runtimeRoot);
    let position = 0;
    for (const entry of schedule) {
      position += 1;
      const runId = `${entry.taskId}--${entry.arm}--r${entry.repetition}`;
      if (completed.has(runId)) {
        process.stdout.write(
          `[eval] ${position}/${schedule.length} resume-skip ${runId}\n`
        );
        continue;
      }
      process.stdout.write(
        `[eval] ${position}/${schedule.length} running ${runId}\n`
      );
      let accepted = false;
      for (let retry = 0; retry <= 1; retry += 1) {
        const record = await executeEntry(
          entry,
          retry,
          options,
          runtimeRoot,
          sandboxProfile,
          manifestHash,
          childEnvironment,
          secretValues
        );
        await appendPrivateJsonLine(
          join(options.resultsDirectory, "runs.jsonl"),
          record
        );
        if (!record.infraFailure) {
          accepted = true;
          break;
        }
        process.stdout.write(
          `[eval] discarded infrastructure attempt ${retry + 1} for ${runId}: ${record.infraReason ?? "unknown"}\n`
        );
      }
      if (!accepted) {
        exhaustedInfrastructureRuns += 1;
        process.stdout.write(
          `[eval] ${runId} exhausted its single infrastructure retry\n`
        );
      }
    }
  } finally {
    await rm(runtimeRoot, { recursive: true, force: true });
  }
  await generateReport(options.resultsDirectory, canonicalReportPath);
  if (stage === "pilot" && exhaustedInfrastructureRuns > 0) {
    throw new Error(
      `Pilot gate failed: ${exhaustedInfrastructureRuns} scheduled run(s) exhausted their infrastructure retry.`
    );
  }
}

async function printPlan(options: RunnerOptions): Promise<void> {
  const pilot = buildSchedule("pilot", options.seed);
  const main = buildSchedule("main", options.seed);
  const acceptance = await loadAcceptance();
  process.stdout.write(
    [
      "Fexor locked coding-harness evaluation",
      `Corpus: ${EVAL_CORPUS.length} tasks`,
      `Pilot: ${pilot.length} runs (4 tasks × 5 arms × 1)`,
      `Stage B: ${main.length} runs (baseline/full × 3; ablations × 1)`,
      `Model/effort: ${options.model} / ${options.effort}`,
      `Per-run caps: ${Math.round(options.timeoutMs / 1000)}s, ${options.maxTurns} turns, ${options.taskBudgetTokens} task tokens, $${options.maxBudgetUsd.toFixed(2)}`,
      `Stage B thresholds approved: ${acceptance.approved ? "yes" : "no"}`,
      "No model calls were made. Use pilot --execute only after approving its expected spend.",
      "",
    ].join("\n")
  );
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (options.command === "plan") {
    await printPlan(options);
  } else if (options.command === "report") {
    process.stdout.write(
      `${await generateReport(options.resultsDirectory, canonicalReportPath)}\n`
    );
  } else {
    await runStage(options.command === "pilot" ? "pilot" : "main", options);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    const safe = redactOutput(
      String(error),
      sensitiveEnvironmentValues(process.env)
    );
    process.stderr.write(`[eval] ERROR: ${safe}\n`);
    process.exitCode = 1;
  });
}
