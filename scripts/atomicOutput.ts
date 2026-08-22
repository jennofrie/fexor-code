import { randomBytes } from "crypto";
import { chmodSync, renameSync, rmSync } from "fs";

export function createAtomicOutputPath(outfile: string): string {
  return `${outfile}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
}

export function commitAtomicExecutable(
  temporaryOutfile: string,
  outfile: string
): void {
  chmodSync(temporaryOutfile, 0o755);
  renameSync(temporaryOutfile, outfile);
}

export function cleanupAtomicOutput(temporaryOutfile: string): void {
  rmSync(temporaryOutfile, { force: true });
}
