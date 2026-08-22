export type EvalArm =
  "baseline" | "verifier-only" | "lsp-only" | "prompt-only" | "full";

export type EvalComplexity = "simple" | "medium" | "complex";

export type ModuleCase = {
  args: unknown[];
  expected?: unknown;
  expectedArgsAfter?: unknown[];
  throwsIncludes?: string;
};

export type JudgeSpec =
  | {
      kind: "module-cases";
      modulePath: string;
      exportName: string;
      cases: ModuleCase[];
    }
  | {
      kind: "module-exports";
      modulePath: string;
      exports: string[];
    }
  | {
      kind: "cli-cases";
      entryPath: string;
      cases: Array<{
        args: string[];
        exitCode: number;
        stdout?: string;
        stderrIncludes?: string;
      }>;
    }
  | {
      kind: "file-contains";
      path: string;
      values: string[];
    }
  | {
      kind: "rust-tests";
      modulePath: string;
      testSource: string;
    };

export type EvalTask = {
  id: string;
  family:
    | "backend"
    | "frontend"
    | "cli"
    | "refactor"
    | "malformed-input"
    | "rust-lsp";
  complexity: EvalComplexity;
  prompt: string;
  files: Record<string, string>;
  allowedPathPrefixes: string[];
  judge: JudgeSpec[];
};

export type AcceptanceThresholds = {
  approved: boolean;
  approvedBy: string;
  approvedAt: string;
  minimumSuccessDeltaPercentagePoints: number;
  maximumFalsePassRate: number;
  maximumCostMultiplier: number;
  maximumInfraFailureRate: number;
  maximumBudgetUsdPerRun: number;
};

export type EvalManifest = {
  schemaVersion: 1;
  createdAt: string;
  stage: "pilot" | "main";
  corpusHash: string;
  binaryHash: string;
  sourceDiffHash: string;
  judgeHash: string;
  runnerHash: string;
  model: string;
  effort: string;
  pluginVersion: string | null;
  taskIds: string[];
  arms: EvalArm[];
  repetitions: number;
  seed: number;
  timeoutMs: number;
  maxTurns: number;
  taskBudgetTokens: number;
  maxBudgetUsd: number;
  environmentVariableNames: string[];
  thresholds: AcceptanceThresholds | null;
};

export type JudgeResult = {
  passed: boolean;
  assertionsPassed: number;
  assertionsFailed: number;
  assertionFailures: string[];
  scopePassed: boolean;
  outOfScopePaths: string[];
  infrastructureFailure?: string;
};

export type TranscriptMetrics = {
  verifierInvocations: number;
  lspToolUses: number;
  validVerdicts: number;
  passVerdicts: number;
  failVerdicts: number;
  partialVerdicts: number;
  finalVerdict: "PASS" | "FAIL" | "PARTIAL" | null;
  inputTokens: number;
  outputTokens: number;
  totalCostUsd: number;
  numTurns: number;
  resultSubtype: string | null;
};

export type EvalRunRecord = {
  schemaVersion: 1;
  runId: string;
  manifestHash: string;
  taskId: string;
  family: EvalTask["family"];
  complexity: EvalComplexity;
  arm: EvalArm;
  repetition: number;
  startedAt: string;
  durationMs: number;
  processExitCode: number | null;
  timedOut: boolean;
  infraFailure: boolean;
  infraReason?: string;
  discarded: boolean;
  retry: number;
  judge: JudgeResult;
  transcript: TranscriptMetrics;
  falsePass: boolean;
  falseFail: boolean;
  falsePartial: boolean;
  stdoutArtifact: string;
  stderrArtifact: string;
  diffArtifact: string;
};

export type EvalScheduleEntry = {
  taskId: string;
  arm: EvalArm;
  repetition: number;
};
