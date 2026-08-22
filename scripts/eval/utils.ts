import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableJson(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(
    value,
    (_key, candidate) => {
      if (candidate instanceof Error) {
        return {
          __evalError: true,
          name: candidate.name,
          message: candidate.message,
        };
      }
      if (
        !candidate ||
        typeof candidate !== "object" ||
        Array.isArray(candidate)
      ) {
        return candidate;
      }
      if (seen.has(candidate))
        throw new Error("Evaluation data must be acyclic");
      seen.add(candidate);
      return Object.fromEntries(
        Object.entries(candidate as Record<string, unknown>).sort(
          ([left], [right]) => left.localeCompare(right)
        )
      );
    },
    2
  );
}

export async function writePrivateFile(
  path: string,
  value: string
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, value, { mode: 0o600 });
}

export async function appendPrivateJsonLine(
  path: string,
  value: unknown
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

export async function hashFile(path: string): Promise<string> {
  return sha256(await readFile(path));
}

const SECRET_NAME =
  /(?:^|_)(?:API_?KEY|AUTH|BEARER|CREDENTIAL|PASSWORD|PRIVATE_?KEY|SECRET|TOKEN)(?:_|$)/i;

export function sensitiveEnvironmentValues(
  environment: NodeJS.ProcessEnv
): string[] {
  return Object.entries(environment)
    .filter(
      ([name, value]) => SECRET_NAME.test(name) && typeof value === "string"
    )
    .map(([, value]) => value as string)
    .filter((value) => value.length >= 4)
    .sort((left, right) => right.length - left.length);
}

export function redactOutput(
  value: string,
  secretValues: readonly string[]
): string {
  let redacted = value;
  for (const secret of secretValues)
    redacted = redacted.split(secret).join("[REDACTED]");
  return redacted
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]")
    .replace(
      /(["']?(?:api[_-]?key|auth[_-]?token|access[_-]?token|password|secret)["']?\s*[:=]\s*["']?)[^\s,"']{4,}/gi,
      "$1[REDACTED]"
    );
}

export async function runText(
  command: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {}
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(command, {
    cwd: options.cwd,
    env: options.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

export function seededShuffle<T>(values: readonly T[], seed: number): T[] {
  const result = [...values];
  let state = seed >>> 0;
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const swapIndex = state % (index + 1);
    [result[index], result[swapIndex]] = [result[swapIndex]!, result[index]!];
  }
  return result;
}
