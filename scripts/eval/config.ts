import type { EvalArm, EvalScheduleEntry } from "./types.js";
import { EVAL_CORPUS } from "./corpus.js";
import { seededShuffle } from "./utils.js";

export const EVAL_ARMS: EvalArm[] = [
  "baseline",
  "verifier-only",
  "lsp-only",
  "prompt-only",
  "full",
];

export const PILOT_TASK_IDS = [
  "backend-pagination-boundary",
  "frontend-menu-state",
  "cli-invalid-exit-code",
  "rust-saturating-decrement",
] as const;

export function environmentForArm(arm: EvalArm): Record<string, string> {
  if (arm === "baseline") {
    return { FEXOR_CODING_HARNESS: "0" };
  }
  return {
    FEXOR_CODING_HARNESS: "1",
    FEXOR_ENABLE_VERIFICATION_AGENT:
      arm === "verifier-only" || arm === "full" ? "1" : "0",
    FEXOR_ENABLE_CODING_PROMPT:
      arm === "prompt-only" || arm === "full" ? "1" : "0",
    ENABLE_LSP_TOOL: arm === "lsp-only" || arm === "full" ? "1" : "0",
  };
}

export function buildSchedule(
  stage: "pilot" | "main",
  seed: number
): EvalScheduleEntry[] {
  const entries: EvalScheduleEntry[] = [];
  if (stage === "pilot") {
    for (const taskId of PILOT_TASK_IDS) {
      for (const arm of EVAL_ARMS) entries.push({ taskId, arm, repetition: 1 });
    }
  } else {
    for (const task of EVAL_CORPUS) {
      for (const arm of ["baseline", "full"] as const) {
        for (let repetition = 1; repetition <= 3; repetition += 1) {
          entries.push({ taskId: task.id, arm, repetition });
        }
      }
      for (const arm of ["verifier-only", "lsp-only", "prompt-only"] as const) {
        entries.push({ taskId: task.id, arm, repetition: 1 });
      }
    }
  }
  return seededShuffle(entries, seed);
}
