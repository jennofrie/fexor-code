import type { TranscriptMetrics } from "./types.js";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function contentBlocks(event: JsonRecord): unknown[] {
  const message = asRecord(event.message);
  return Array.isArray(message?.content) ? message.content : [];
}

export function parseStrictVerdict(
  value: string
): "PASS" | "FAIL" | "PARTIAL" | null {
  const lines = value.replace(/\s+$/u, "").split(/\r?\n/u);
  const terminalLines = lines.filter((line) =>
    /^VERDICT: (PASS|FAIL|PARTIAL)$/u.test(line)
  );
  if (terminalLines.length !== 1) return null;
  const match = /^VERDICT: (PASS|FAIL|PARTIAL)$/u.exec(lines.at(-1) ?? "");
  return (match?.[1] as "PASS" | "FAIL" | "PARTIAL" | undefined) ?? null;
}

function textFromToolResult(block: JsonRecord): string {
  if (typeof block.content === "string") return block.content;
  if (!Array.isArray(block.content)) return "";
  return block.content
    .map((item) => {
      const record = asRecord(item);
      return record?.type === "text" && typeof record.text === "string"
        ? record.text
        : "";
    })
    .filter(Boolean)
    .join("\n");
}

function numeric(record: JsonRecord | null, key: string): number {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function parseTranscript(stdout: string): TranscriptMetrics {
  const metrics: TranscriptMetrics = {
    verifierInvocations: 0,
    lspToolUses: 0,
    validVerdicts: 0,
    passVerdicts: 0,
    failVerdicts: 0,
    partialVerdicts: 0,
    finalVerdict: null,
    inputTokens: 0,
    outputTokens: 0,
    totalCostUsd: 0,
    numTurns: 0,
    resultSubtype: null,
  };
  const verifierToolIds = new Set<string>();

  for (const line of stdout.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let event: JsonRecord;
    try {
      const parsed = JSON.parse(line) as unknown;
      const record = asRecord(parsed);
      if (!record) continue;
      event = record;
    } catch {
      continue;
    }

    for (const candidate of contentBlocks(event)) {
      const block = asRecord(candidate);
      if (!block) continue;
      if (block.type === "tool_use" && typeof block.name === "string") {
        const input = asRecord(block.input);
        if (block.name === "LSP") metrics.lspToolUses += 1;
        if (
          block.name === "Agent" &&
          input?.subagent_type === "verification" &&
          typeof block.id === "string"
        ) {
          metrics.verifierInvocations += 1;
          verifierToolIds.add(block.id);
          // A later attempt supersedes any earlier verdict even if it crashes
          // or returns malformed output.
          metrics.finalVerdict = null;
        }
      }
      if (
        block.type === "tool_result" &&
        typeof block.tool_use_id === "string" &&
        verifierToolIds.has(block.tool_use_id)
      ) {
        const verdict = parseStrictVerdict(textFromToolResult(block));
        metrics.finalVerdict = verdict;
        if (!verdict) continue;
        metrics.validVerdicts += 1;
        if (verdict === "PASS") metrics.passVerdicts += 1;
        if (verdict === "FAIL") metrics.failVerdicts += 1;
        if (verdict === "PARTIAL") metrics.partialVerdicts += 1;
      }
    }

    if (event.type === "result") {
      const usage = asRecord(event.usage);
      metrics.inputTokens = numeric(usage, "input_tokens");
      metrics.outputTokens = numeric(usage, "output_tokens");
      metrics.totalCostUsd = numeric(event, "total_cost_usd");
      metrics.numTurns = numeric(event, "num_turns");
      metrics.resultSubtype =
        typeof event.subtype === "string" ? event.subtype : null;
    }
  }
  return metrics;
}
