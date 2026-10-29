/**
 * Per-process effort-support latch.
 *
 * Official Claude Code 2.1.310 retries a request without the effort beta and
 * `output_config.effort` when a gateway rejects them, then latches the model
 * so later requests do not resend either field. This matters for
 * Anthropic-compatible third-party endpoints that implement the core Messages
 * API but reject Anthropic-only effort controls.
 */

import { APIError } from "@anthropic-ai/sdk/error";

const unsupportedModels = new Set<string>();

function modelKey(model: string): string {
  return model.trim().toLowerCase();
}

export function isEffortUnsupportedForModel(model: string): boolean {
  return unsupportedModels.has(modelKey(model));
}

export function markEffortUnsupportedForModel(model: string): void {
  unsupportedModels.add(modelKey(model));
}

/** Test hook; production latches live for the process lifetime. */
export function resetEffortUnsupportedForTests(): void {
  unsupportedModels.clear();
}

export function isEffortUnsupportedMessage(
  status: number | undefined,
  message: string
): boolean {
  if (status !== 400 && status !== 422) {
    return false;
  }

  // A rejected structured-output or task-budget field is a different
  // recovery path; stripping effort would not fix that request.
  if (/output_config\.format/i.test(message) || /task_budget/i.test(message)) {
    return false;
  }

  if (/effort_unsupported/i.test(message)) {
    return true;
  }

  if (
    /does not support the effort parameter/i.test(message) ||
    /effort(?:\s+level)?[\s\S]{0,60}(?:unsupported|not supported)/i.test(
      message
    ) ||
    /requires a model that supports[\s\S]{0,60}effort/i.test(message)
  ) {
    return true;
  }

  return /output_config/i.test(message) && /extra inputs are not permitted/i.test(message);
}

export function isEffortUnsupportedError(error: unknown): boolean {
  if (!(error instanceof APIError)) {
    return false;
  }
  return isEffortUnsupportedMessage(error.status, error.message);
}
