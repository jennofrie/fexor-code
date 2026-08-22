import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repositoryRoot = resolve(dirname(import.meta.dir));
const temporaryRoots: string[] = [];

type LaunchCapture = {
  master: string | null;
  verification: string | null;
  codingPrompt: string | null;
  lsp: string | null;
  subagentModel: string | null;
  args: string[];
};

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function captureLaunch(
  environment: Record<string, string> = {},
  args: string[] = []
): Promise<LaunchCapture> {
  const root = await mkdtemp(join(tmpdir(), "fexor-launcher-test-"));
  temporaryRoots.push(root);
  const promptDirectory = join(root, "prompts");
  await mkdir(promptDirectory);
  await copyFile(
    join(repositoryRoot, "launch-glm.sh"),
    join(root, "launch-glm.sh")
  );
  await copyFile(
    join(repositoryRoot, "prompts/glm-autonomy-system-prompt.md"),
    join(promptDirectory, "glm-autonomy-system-prompt.md")
  );
  await copyFile(
    join(repositoryRoot, "prompts/glm-coding-harness-prompt.md"),
    join(promptDirectory, "glm-coding-harness-prompt.md")
  );
  await copyFile(
    join(repositoryRoot, "prompts/harness-lsp-settings.json"),
    join(promptDirectory, "harness-lsp-settings.json")
  );
  await writeFile(
    join(root, "cli-dev"),
    `#!/usr/bin/env bun
console.log(JSON.stringify({
  master: process.env.FEXOR_CODING_HARNESS ?? null,
  verification: process.env.FEXOR_ENABLE_VERIFICATION_AGENT ?? null,
  codingPrompt: process.env.FEXOR_ENABLE_CODING_PROMPT ?? null,
  lsp: process.env.ENABLE_LSP_TOOL ?? null,
  subagentModel: process.env.CLAUDE_CODE_SUBAGENT_MODEL ?? null,
  args: process.argv.slice(2),
}))
`
  );
  await chmod(join(root, "cli-dev"), 0o755);

  const child = Bun.spawn(["/bin/zsh", join(root, "launch-glm.sh"), ...args], {
    env: {
      HOME: join(root, "home"),
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      TMPDIR: tmpdir(),
      USER: "fexor-launcher-test",
      GLM_API_KEY: "non-secret-test-value",
      ...environment,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode, stderr).toBe(0);
  return JSON.parse(stdout.trim()) as LaunchCapture;
}

function valuesAfter(args: string[], flag: string): string[] {
  const values: string[] = [];
  args.forEach((value, index) => {
    if (value === flag) values.push(args[index + 1] ?? "");
  });
  return values;
}

describe("GLM coding-harness launcher matrix", () => {
  test("off preserves the legacy environment and default argument surface", async () => {
    const capture = await captureLaunch();
    expect(capture.master).toBeNull();
    expect(capture.verification).toBeNull();
    expect(capture.codingPrompt).toBeNull();
    expect(capture.lsp).toBeNull();
    expect(capture.subagentModel).toBe("glm-4.5-air");
    expect(valuesAfter(capture.args, "--append-system-prompt")).toEqual([]);
    expect(
      valuesAfter(capture.args, "--append-system-prompt-file")
    ).toHaveLength(1);
    expect(valuesAfter(capture.args, "--setting-sources")).toEqual([""]);
    expect(valuesAfter(capture.args, "--settings")).toEqual([]);
  });

  test("only exact master value 1 enables the harness", async () => {
    const capture = await captureLaunch({ FEXOR_CODING_HARNESS: "true" });
    expect(capture.master).toBe("true");
    expect(capture.verification).toBeNull();
    expect(capture.codingPrompt).toBeNull();
    expect(capture.lsp).toBeNull();
    expect(valuesAfter(capture.args, "--append-system-prompt")).toEqual([]);
  });

  test("off preserves legacy setting-sources behavior with caller settings", async () => {
    const capture = await captureLaunch({}, ["--settings", "caller.json"]);
    expect(valuesAfter(capture.args, "--setting-sources")).toEqual([""]);
    expect(valuesAfter(capture.args, "--settings")).toEqual(["caller.json"]);
  });

  test("on enables verification, LSP settings, and one combined prompt", async () => {
    const capture = await captureLaunch({ FEXOR_CODING_HARNESS: "1" });
    expect(capture.master).toBe("1");
    expect(capture.verification).toBe("1");
    expect(capture.codingPrompt).toBe("1");
    expect(capture.lsp).toBe("1");
    expect(capture.subagentModel).toBe("glm-4.5-air");
    const prompts = valuesAfter(capture.args, "--append-system-prompt");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Fexor Agent Harness Policy");
    expect(prompts[0]).toContain("Coding harness discipline");
    expect(valuesAfter(capture.args, "--append-system-prompt-file")).toEqual(
      []
    );
    expect(valuesAfter(capture.args, "--setting-sources")).toEqual([""]);
    expect(valuesAfter(capture.args, "--settings")[0]).toEndWith(
      "/prompts/harness-lsp-settings.json"
    );
  });

  test("individual hard opt-outs remain effective", async () => {
    const capture = await captureLaunch({
      FEXOR_CODING_HARNESS: "1",
      FEXOR_ENABLE_VERIFICATION_AGENT: "0",
      FEXOR_ENABLE_CODING_PROMPT: "0",
      ENABLE_LSP_TOOL: "false",
    });
    expect(capture.verification).toBe("0");
    expect(capture.codingPrompt).toBe("0");
    expect(capture.lsp).toBe("false");
    expect(valuesAfter(capture.args, "--settings")).toEqual([]);
    expect(valuesAfter(capture.args, "--setting-sources")).toEqual([""]);
    expect(valuesAfter(capture.args, "--append-system-prompt")).toEqual([]);
    expect(
      valuesAfter(capture.args, "--append-system-prompt-file")
    ).toHaveLength(1);
  });

  test("explicit prompt and settings arguments win without duplicates", async () => {
    const capture = await captureLaunch({ FEXOR_CODING_HARNESS: "1" }, [
      "--append-system-prompt",
      "caller prompt",
      "--setting-sources",
      "user",
      "--settings",
      "caller-settings.json",
    ]);
    expect(valuesAfter(capture.args, "--append-system-prompt")).toEqual([
      "caller prompt",
    ]);
    expect(valuesAfter(capture.args, "--append-system-prompt-file")).toEqual(
      []
    );
    expect(valuesAfter(capture.args, "--setting-sources")).toEqual(["user"]);
    expect(valuesAfter(capture.args, "--settings")).toEqual([
      "caller-settings.json",
    ]);
  });
});
