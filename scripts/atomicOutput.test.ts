import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  cleanupAtomicOutput,
  commitAtomicExecutable,
  createAtomicOutputPath,
} from "./atomicOutput.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("atomic build output", () => {
  test("failed build cleanup leaves the previous executable byte-identical", async () => {
    const root = await mkdtemp(join(tmpdir(), "fexor-atomic-output-"));
    roots.push(root);
    const outfile = join(root, "cli-dev");
    const temporary = createAtomicOutputPath(outfile);
    await writeFile(outfile, "previous binary");
    await writeFile(temporary, "partial failed build");

    cleanupAtomicOutput(temporary);

    expect(await readFile(outfile, "utf8")).toBe("previous binary");
    await expect(stat(temporary)).rejects.toThrow();
  });

  test("successful build renames a complete executable over the destination", async () => {
    const root = await mkdtemp(join(tmpdir(), "fexor-atomic-output-"));
    roots.push(root);
    const outfile = join(root, "cli-dev");
    const temporary = createAtomicOutputPath(outfile);
    await writeFile(outfile, "previous binary");
    await writeFile(temporary, "complete binary");

    commitAtomicExecutable(temporary, outfile);

    expect(await readFile(outfile, "utf8")).toBe("complete binary");
    expect((await stat(outfile)).mode & 0o777).toBe(0o755);
    await expect(stat(temporary)).rejects.toThrow();
  });
});
