import { randomUUID } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { getClaudeConfigHomeDir } from "./envUtils.js";

// Upstream 2.1.89: hook stdout over 10K chars is spilled to disk and replaced
// with a path plus a 2K preview instead of being injected into context.
export const MAX_INLINE_HOOK_CONTEXT_CHARS = 10_000;
export const HOOK_CONTEXT_PREVIEW_CHARS = 2_000;

function safeHookName(hookName: string): string {
  return hookName.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 48) || "hook";
}

/**
 * Keep small hook context inline. Spill large context to a private file and
 * return a bounded reference. Fail open: if the write fails, return the
 * original content so a hook is never silently dropped.
 */
export async function spillLargeHookContext(
  content: string,
  hookName: string
): Promise<string> {
  if (content.length <= MAX_INLINE_HOOK_CONTEXT_CHARS) {
    return content;
  }

  const dir = join(getClaudeConfigHomeDir(), "hook-output");
  const filepath = join(
    dir,
    `${safeHookName(hookName)}-${Date.now()}-${randomUUID()}.txt`
  );

  try {
    await mkdir(dir, { recursive: true });
    await writeFile(filepath, content, { encoding: "utf8", mode: 0o600 });
  } catch {
    return content;
  }

  return [
    `<hook-output-too-large chars="${content.length}" file="${filepath}">`,
    `Preview (first ${HOOK_CONTEXT_PREVIEW_CHARS} chars):`,
    content.slice(0, HOOK_CONTEXT_PREVIEW_CHARS),
    "...",
    "</hook-output-too-large>",
  ].join("\n");
}
