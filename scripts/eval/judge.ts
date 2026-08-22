import {
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { EvalTask, JudgeResult, JudgeSpec } from "./types.js";
import { runText } from "./utils.js";

type MutableJudgeResult = Omit<JudgeResult, "passed">;
type CandidateSandbox = {
  profilePath?: string;
  root: string;
};

const repositoryRoot = resolve(import.meta.dir, "../..");
const JUDGE_RESULT_MARKER = "__FEXOR_LOCKED_JUDGE_RESULT__";

function assertion(
  result: MutableJudgeResult,
  condition: boolean,
  failure: string
): void {
  if (condition) {
    result.assertionsPassed += 1;
  } else {
    result.assertionsFailed += 1;
    result.assertionFailures.push(failure);
  }
}

function safeWorkspacePath(workspace: string, relativePath: string): string {
  if (isAbsolute(relativePath)) throw new Error("Judge paths must be relative");
  const root = resolve(workspace);
  const path = resolve(root, relativePath);
  if (path !== root && !path.startsWith(`${root}/`)) {
    throw new Error(`Judge path escapes workspace: ${relativePath}`);
  }
  return path;
}

function sandboxString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
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

function candidateEnvironment(privateHome?: string): Record<string, string> {
  const userHome = homedir();
  const environment: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: privateHome ?? userHome,
    LANG: process.env.LANG ?? "C.UTF-8",
    CI: "1",
    NO_COLOR: "1",
    RUSTUP_HOME: process.env.RUSTUP_HOME ?? join(userHome, ".rustup"),
    CARGO_HOME:
      privateHome ?? process.env.CARGO_HOME ?? join(userHome, ".cargo"),
  };
  for (const name of ["TMPDIR"]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  if (privateHome) environment.TMPDIR = privateHome;
  return environment;
}

async function createCandidateSandbox(
  workspace: string
): Promise<CandidateSandbox> {
  const root = await mkdtemp(join(tmpdir(), "fexor-eval-candidate-judge-"));
  if (
    process.platform !== "darwin" ||
    !(await pathExists("/usr/bin/sandbox-exec"))
  ) {
    return { root };
  }
  const [canonicalRepository, canonicalWorkspace, canonicalRoot] =
    await Promise.all([
      realpath(repositoryRoot),
      realpath(workspace),
      realpath(root),
    ]);
  const profilePath = join(root, "candidate.sb");
  const userHome = homedir();
  const homeToolchainReads = [
    resolve(userHome, ".bun", "bin"),
    resolve(userHome, ".cargo", "bin"),
    resolve(userHome, ".rustup"),
  ];
  await writeFile(
    profilePath,
    `(version 1)\n(deny file-read* file-write* (subpath ${sandboxString(canonicalRepository)}))\n(deny file-read* (subpath ${sandboxString(userHome)}))\n${homeToolchainReads.map((path) => `(allow file-read* (subpath ${sandboxString(path)}))`).join("\n")}\n(deny file-write* (subpath ${sandboxString(canonicalWorkspace)}))\n(allow file-read* file-write* (subpath ${sandboxString(canonicalRoot)}))\n(deny network*)\n(allow default)\n`,
    { mode: 0o600 }
  );
  return { profilePath, root };
}

async function runCandidate(
  command: string[],
  workspace: string,
  sandbox: CandidateSandbox
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const lockedCommand = sandbox.profilePath
    ? ["/usr/bin/sandbox-exec", "-f", sandbox.profilePath, ...command]
    : command;
  return runText(lockedCommand, {
    cwd: workspace,
    env: candidateEnvironment(sandbox.root),
  });
}

type CandidateCheck = { passed: boolean; failure: string };

function parseCandidateChecks(stdout: string): CandidateCheck[] | null {
  const markerIndex = stdout.lastIndexOf(JUDGE_RESULT_MARKER);
  if (markerIndex === -1) return null;
  const line = stdout
    .slice(markerIndex + JUDGE_RESULT_MARKER.length)
    .split(/\r?\n/u, 1)[0];
  try {
    const parsed = JSON.parse(line ?? "") as unknown;
    if (!Array.isArray(parsed)) return null;
    if (
      !parsed.every(
        (value) =>
          value !== null &&
          typeof value === "object" &&
          "passed" in value &&
          typeof value.passed === "boolean" &&
          "failure" in value &&
          typeof value.failure === "string"
      )
    ) {
      return null;
    }
    return parsed as CandidateCheck[];
  } catch {
    return null;
  }
}

async function judgeModule(
  spec: Extract<JudgeSpec, { kind: "module-cases" | "module-exports" }>,
  workspace: string,
  result: MutableJudgeResult,
  sandbox: CandidateSandbox
): Promise<void> {
  const path = safeWorkspacePath(workspace, spec.modulePath);
  const scriptPath = join(
    sandbox.root,
    `module-${result.assertionsPassed}-${result.assertionsFailed}.ts`
  );
  const serializedSpec = JSON.stringify(spec);
  const serializedModuleUrl = JSON.stringify(pathToFileURL(path).href);
  await writeFile(
    scriptPath,
    `import { isDeepStrictEqual } from 'node:util'\n
const spec = ${serializedSpec}\n
const checks: Array<{ passed: boolean; failure: string }> = []\n
const check = (passed: boolean, failure: string) => checks.push({ passed, failure })\n
try {\n
  const candidateModule = await import(${serializedModuleUrl}) as Record<string, unknown>\n
  if (spec.kind === 'module-exports') {\n
    for (const exportName of spec.exports) {\n
      check(exportName in candidateModule, spec.modulePath + ' is missing export ' + exportName)\n
    }\n
  } else {\n
    const candidate = candidateModule[spec.exportName]\n
    if (typeof candidate !== 'function') {\n
      check(false, spec.modulePath + ' export ' + spec.exportName + ' is not a function')\n
    } else {\n
      for (const [caseIndex, testCase] of spec.cases.entries()) {\n
        const invocationArgs = structuredClone(testCase.args)\n
        try {\n
          const actual = await candidate(...invocationArgs)\n
          if (testCase.throwsIncludes !== undefined) {\n
            check(false, spec.exportName + ' case ' + (caseIndex + 1) + ' did not throw')\n
          } else {\n
            check(isDeepStrictEqual(actual, testCase.expected), spec.exportName + ' case ' + (caseIndex + 1) + ': expected ' + JSON.stringify(testCase.expected) + ', received ' + JSON.stringify(actual))\n
          }\n
        } catch (error) {\n
          if (testCase.throwsIncludes === undefined) {\n
            check(false, spec.exportName + ' case ' + (caseIndex + 1) + ' threw: ' + String(error))\n
          } else {\n
            check(String(error).toLowerCase().includes(testCase.throwsIncludes.toLowerCase()), spec.exportName + ' case ' + (caseIndex + 1) + ': error did not include ' + JSON.stringify(testCase.throwsIncludes))\n
          }\n
        }\n
        if (testCase.expectedArgsAfter !== undefined) {\n
          check(isDeepStrictEqual(invocationArgs, testCase.expectedArgsAfter), spec.exportName + ' case ' + (caseIndex + 1) + ' mutated its arguments')\n
        }\n
      }\n
    }\n
  }\n
} catch (error) {\n
  check(false, spec.modulePath + ' failed to import: ' + String(error))\n
}\n
process.stdout.write(${JSON.stringify(JUDGE_RESULT_MARKER)} + JSON.stringify(checks) + '\\n')\n`,
    { mode: 0o600 }
  );
  const execution = await runCandidate(
    [process.execPath, scriptPath],
    workspace,
    sandbox
  );
  const checks = parseCandidateChecks(execution.stdout);
  if (!checks) {
    assertion(
      result,
      false,
      `${spec.modulePath} locked judge failed (exit ${execution.exitCode}): ${execution.stderr.trim()}`
    );
    return;
  }
  for (const check of checks) assertion(result, check.passed, check.failure);
}

async function judgeCli(
  spec: Extract<JudgeSpec, { kind: "cli-cases" }>,
  workspace: string,
  result: MutableJudgeResult,
  sandbox: CandidateSandbox
): Promise<void> {
  const entry = safeWorkspacePath(workspace, spec.entryPath);
  for (const [caseIndex, testCase] of spec.cases.entries()) {
    const execution = await runCandidate(
      [process.execPath, entry, ...testCase.args],
      workspace,
      sandbox
    );
    assertion(
      result,
      execution.exitCode === testCase.exitCode,
      `${spec.entryPath} case ${caseIndex + 1}: expected exit ${testCase.exitCode}, received ${execution.exitCode}`
    );
    if (testCase.stdout !== undefined) {
      assertion(
        result,
        execution.stdout.trim() === testCase.stdout,
        `${spec.entryPath} case ${caseIndex + 1}: stdout mismatch`
      );
    }
    if (testCase.stderrIncludes !== undefined) {
      assertion(
        result,
        execution.stderr.includes(testCase.stderrIncludes),
        `${spec.entryPath} case ${caseIndex + 1}: stderr missing ${JSON.stringify(testCase.stderrIncludes)}`
      );
    }
  }
}

async function judgeFile(
  spec: Extract<JudgeSpec, { kind: "file-contains" }>,
  workspace: string,
  result: MutableJudgeResult
): Promise<void> {
  let content = "";
  try {
    content = await readFile(safeWorkspacePath(workspace, spec.path), "utf8");
  } catch (error) {
    assertion(
      result,
      false,
      `${spec.path} could not be read: ${String(error)}`
    );
    return;
  }
  for (const value of spec.values) {
    assertion(
      result,
      content.includes(value),
      `${spec.path} is missing ${JSON.stringify(value)}`
    );
  }
}

async function judgeRust(
  spec: Extract<JudgeSpec, { kind: "rust-tests" }>,
  workspace: string,
  result: MutableJudgeResult,
  sandbox: CandidateSandbox
): Promise<void> {
  const rustc = await runText(
    ["/usr/bin/env", "sh", "-c", "command -v rustc"],
    {
      env: candidateEnvironment(),
    }
  );
  if (rustc.exitCode !== 0 || !rustc.stdout.trim()) {
    result.infrastructureFailure = "rustc is unavailable for a Rust judge";
    return;
  }
  const root = await mkdtemp(join(sandbox.root, "rust-"));
  try {
    const sourcePath = safeWorkspacePath(workspace, spec.modulePath);
    const judgePath = join(root, "judge.rs");
    const executable = join(root, "judge-test");
    await writeFile(
      judgePath,
      `#[path = ${JSON.stringify(sourcePath)}]\nmod candidate;\n${spec.testSource}\n`,
      { mode: 0o600 }
    );
    const compilation = await runCandidate(
      [
        rustc.stdout.trim(),
        "--edition=2021",
        "--test",
        judgePath,
        "-o",
        executable,
      ],
      workspace,
      sandbox
    );
    assertion(
      result,
      compilation.exitCode === 0,
      `${spec.modulePath} hidden tests did not compile: ${compilation.stderr.trim()}`
    );
    if (compilation.exitCode !== 0) return;
    const execution = await runCandidate([executable], workspace, sandbox);
    assertion(
      result,
      execution.exitCode === 0,
      `${spec.modulePath} hidden Rust tests failed: ${execution.stdout.trim()} ${execution.stderr.trim()}`.trim()
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function allowedPath(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) =>
    prefix.endsWith("/") ? path.startsWith(prefix) : path === prefix
  );
}

export function parseChangedPaths(porcelain: string): string[] {
  const records = porcelain.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 4) continue;
    const status = record.slice(0, 2);
    paths.push(record.slice(3));
    if (/[RC]/u.test(status)) {
      const original = records[index + 1];
      if (original) paths.push(original);
      index += 1;
    }
  }
  return [...new Set(paths)].sort();
}

export async function judgeTask(
  task: EvalTask,
  workspace: string
): Promise<JudgeResult> {
  const result: MutableJudgeResult = {
    assertionsPassed: 0,
    assertionsFailed: 0,
    assertionFailures: [],
    scopePassed: true,
    outOfScopePaths: [],
  };
  const sandbox = await createCandidateSandbox(workspace);
  try {
    for (const spec of task.judge) {
      if (result.infrastructureFailure) break;
      if (spec.kind === "module-cases" || spec.kind === "module-exports") {
        await judgeModule(spec, workspace, result, sandbox);
      } else if (spec.kind === "cli-cases") {
        await judgeCli(spec, workspace, result, sandbox);
      } else if (spec.kind === "file-contains") {
        await judgeFile(spec, workspace, result);
      } else {
        await judgeRust(spec, workspace, result, sandbox);
      }
    }

    const status = await runText(
      ["git", "status", "--porcelain=v1", "-z", "--untracked-files=all"],
      { cwd: workspace, env: candidateEnvironment() }
    );
    if (status.exitCode !== 0) {
      result.infrastructureFailure ??= `git status failed: ${status.stderr.trim()}`;
    } else {
      const changed = parseChangedPaths(status.stdout);
      result.outOfScopePaths = changed.filter(
        (path) => !allowedPath(path, task.allowedPathPrefixes)
      );
      result.scopePassed = result.outOfScopePaths.length === 0;
      assertion(
        result,
        result.scopePassed,
        `Out-of-scope paths changed: ${result.outOfScopePaths.join(", ")}`
      );
    }
  } finally {
    await rm(sandbox.root, { recursive: true, force: true });
  }

  return {
    ...result,
    passed:
      !result.infrastructureFailure &&
      result.assertionsFailed === 0 &&
      result.scopePassed,
  };
}
