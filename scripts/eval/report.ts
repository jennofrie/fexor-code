import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EvalArm, EvalManifest, EvalRunRecord } from "./types.js";
import { writePrivateFile } from "./utils.js";

type ArmSummary = {
  runs: number;
  successes: number;
  successRate: number;
  verifierInvocationRate: number;
  validVerdictRate: number;
  falsePassRate: number;
  falseFailRate: number;
  falsePartialRate: number;
  lspUses: number;
  averageInputTokens: number;
  averageOutputTokens: number;
  averageCostUsd: number;
  averageDurationMs: number;
};

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function mean(values: number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((total, value) => total + value, 0) / values.length;
}

function summarize(records: EvalRunRecord[]): ArmSummary {
  const successes = records.filter((record) => record.judge.passed).length;
  const verifierInvocations = records.reduce(
    (total, record) => total + record.transcript.verifierInvocations,
    0
  );
  const validVerdicts = records.reduce(
    (total, record) => total + record.transcript.validVerdicts,
    0
  );
  const passVerdicts = records.filter(
    (record) => record.transcript.finalVerdict === "PASS"
  ).length;
  const failVerdicts = records.filter(
    (record) => record.transcript.finalVerdict === "FAIL"
  ).length;
  const partialVerdicts = records.filter(
    (record) => record.transcript.finalVerdict === "PARTIAL"
  ).length;
  return {
    runs: records.length,
    successes,
    successRate: ratio(successes, records.length),
    verifierInvocationRate: ratio(
      records.filter((record) => record.transcript.verifierInvocations > 0)
        .length,
      records.length
    ),
    validVerdictRate: ratio(validVerdicts, verifierInvocations),
    falsePassRate: ratio(
      records.filter((record) => record.falsePass).length,
      passVerdicts
    ),
    falseFailRate: ratio(
      records.filter((record) => record.falseFail).length,
      failVerdicts
    ),
    falsePartialRate: ratio(
      records.filter((record) => record.falsePartial).length,
      partialVerdicts
    ),
    lspUses: records.reduce(
      (total, record) => total + record.transcript.lspToolUses,
      0
    ),
    averageInputTokens: mean(
      records.map((record) => record.transcript.inputTokens)
    ),
    averageOutputTokens: mean(
      records.map((record) => record.transcript.outputTokens)
    ),
    averageCostUsd: mean(
      records.map((record) => record.transcript.totalCostUsd)
    ),
    averageDurationMs: mean(records.map((record) => record.durationMs)),
  };
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function money(value: number): string {
  return `$${value.toFixed(4)}`;
}

async function readJsonLines(path: string): Promise<EvalRunRecord[]> {
  let content = "";
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return content
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as EvalRunRecord);
}

export async function generateReport(
  resultsDirectory: string,
  canonicalReportPath?: string
): Promise<string> {
  const manifest = JSON.parse(
    await readFile(join(resultsDirectory, "manifest.json"), "utf8")
  ) as EvalManifest;
  const allRecords = await readJsonLines(join(resultsDirectory, "runs.jsonl"));
  const records = allRecords.filter(
    (record) => !record.discarded && !record.infraFailure
  );
  const runIds = [...new Set(allRecords.map((record) => record.runId))];
  const exhaustedInfrastructureRuns = runIds.filter(
    (runId) =>
      !allRecords.some(
        (record) =>
          record.runId === runId && !record.discarded && !record.infraFailure
      )
  ).length;
  const infrastructureFailureRate = ratio(
    exhaustedInfrastructureRuns,
    runIds.length
  );
  const arms = [...new Set(records.map((record) => record.arm))] as EvalArm[];
  const summaries = new Map(
    arms.map((arm) => [
      arm,
      summarize(records.filter((record) => record.arm === arm)),
    ])
  );
  const lines = [
    "# Fexor coding-harness evaluation report",
    "",
    `Generated from locked manifest \`${manifest.stage}\` (${manifest.createdAt}).`,
    "",
    "| Arm | Runs | Success | Verifier invoked | Valid verdict | False PASS | False FAIL | False PARTIAL | LSP uses | Avg input | Avg output | Avg cost | Avg latency |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const arm of arms) {
    const value = summaries.get(arm)!;
    lines.push(
      `| ${arm} | ${value.runs} | ${percent(value.successRate)} | ${percent(value.verifierInvocationRate)} | ${percent(value.validVerdictRate)} | ${percent(value.falsePassRate)} | ${percent(value.falseFailRate)} | ${percent(value.falsePartialRate)} | ${value.lspUses} | ${value.averageInputTokens.toFixed(0)} | ${value.averageOutputTokens.toFixed(0)} | ${money(value.averageCostUsd)} | ${(value.averageDurationMs / 1000).toFixed(1)}s |`
    );
  }

  const baseline = summaries.get("baseline");
  const full = summaries.get("full");
  if (baseline && full) {
    const deltaPoints = (full.successRate - baseline.successRate) * 100;
    const costMultiplier =
      baseline.averageCostUsd === 0
        ? Number.POSITIVE_INFINITY
        : full.averageCostUsd / baseline.averageCostUsd;
    lines.push(
      "",
      "## Pre-registered full-vs-baseline checks",
      "",
      `- Task-success delta: ${deltaPoints.toFixed(1)} percentage points.`,
      `- Full-arm false-PASS rate: ${percent(full.falsePassRate)}.`,
      `- Average-cost multiplier: ${Number.isFinite(costMultiplier) ? `${costMultiplier.toFixed(2)}×` : "not computable"}.`,
      `- Exhausted-run infrastructure failure rate: ${percent(infrastructureFailureRate)}.`
    );
    if (manifest.thresholds?.approved) {
      const thresholds = manifest.thresholds;
      lines.push(
        `- Success threshold: ${deltaPoints >= thresholds.minimumSuccessDeltaPercentagePoints ? "PASS" : "FAIL"} (minimum ${thresholds.minimumSuccessDeltaPercentagePoints}pp).`,
        `- False-PASS threshold: ${full.falsePassRate < thresholds.maximumFalsePassRate ? "PASS" : "FAIL"} (maximum ${percent(thresholds.maximumFalsePassRate)}).`,
        `- Cost threshold: ${costMultiplier <= thresholds.maximumCostMultiplier ? "PASS" : "FAIL"} (maximum ${thresholds.maximumCostMultiplier.toFixed(2)}×).`,
        `- Infrastructure threshold: ${infrastructureFailureRate <= thresholds.maximumInfraFailureRate ? "PASS" : "FAIL"} (maximum ${percent(thresholds.maximumInfraFailureRate)}).`
      );
    } else {
      lines.push(
        "- Acceptance thresholds were not approved for this stage; no claim is made."
      );
    }
  }

  const infraRecords = allRecords.filter((record) => record.infraFailure);
  lines.push(
    "",
    "## Run integrity",
    "",
    `- Counted runs: ${records.length}.`,
    `- Discarded infrastructure attempts: ${infraRecords.length}.`,
    `- Scheduled runs that exhausted their retry: ${exhaustedInfrastructureRuns} of ${runIds.length}.`,
    `- Corpus hash: \`${manifest.corpusHash}\`.`,
    `- Binary hash: \`${manifest.binaryHash}\`.`,
    `- Source-diff hash: \`${manifest.sourceDiffHash}\`.`,
    "",
    "This 24-task corpus is an early-development signal, not a statistically strong general competence claim. Expand and diversify it before publishing broad conclusions.",
    ""
  );
  const report = lines.join("\n");
  await writePrivateFile(join(resultsDirectory, "REPORT.md"), report);
  if (canonicalReportPath) await writeFile(canonicalReportPath, report, "utf8");
  return report;
}
