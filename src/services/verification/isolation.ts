import { execFile } from "child_process";
import { SandboxManager as BaseSandboxManager } from "@anthropic-ai/sandbox-runtime";
import {
  cp as copyTree,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  writeFile,
} from "fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "path";
import { promisify } from "util";
import { fingerprintWorkspace } from "./contract.js";

const execFileAsync = promisify(execFile);
const SNAPSHOT_PREFIX = ".fexor-verification-snapshot-";
const TEMP_PREFIX = ".fexor-verification-tmp-";
const COPY_ATTEMPTS = 2;

export type VerificationSnapshot = {
  workspaceRoot: string;
  snapshotRoot: string;
  tempRoot: string;
  /** Revision of the main workspace to which the attempt is bound. */
  revision: string;
  /** Snapshot revision after credential files and unsafe Git config are removed. */
  integrityRevision: string;
  redactedPaths: string[];
  cleanup(): Promise<void>;
};

const SECRET_FILE_PATTERN =
  /^(?:\.env(?:\..+)?|\.envrc|\.npmrc|\.pypirc|\.netrc|credentials(?:\.json)?|service-account\.json|id_(?:rsa|dsa|ecdsa|ed25519)|.+\.(?:pem|key|p12|pfx|jks))$/i;
const SAFE_SECRET_TEMPLATE_PATTERN = /\.env\.(?:example|sample|template)$/i;
const SECRET_SCAN_SKIP_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".venv",
  "dist",
  "node_modules",
  "target",
  "vendor",
]);

async function redactSensitiveSnapshotFiles(
  snapshotRoot: string
): Promise<string[]> {
  const redacted: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SECRET_SCAN_SKIP_DIRECTORIES.has(entry.name)) await walk(path);
        continue;
      }
      if (
        entry.isFile() &&
        SECRET_FILE_PATTERN.test(entry.name) &&
        !SAFE_SECRET_TEMPLATE_PATTERN.test(entry.name)
      ) {
        redacted.push(relative(snapshotRoot, path).split(sep).join("/"));
        await rm(path, { force: true });
      }
    }
  };
  await walk(snapshotRoot);
  return redacted.sort();
}

const UNSAFE_GIT_CONFIG_SECTIONS = new Set([
  "alias",
  "credential",
  "diff",
  "filter",
  "gpg",
  "http",
  "include",
  "includeif",
  "merge",
  "remote",
  "url",
  "user",
]);

function sanitizeGitConfigText(config: string): string {
  const output: string[] = [];
  let blockedSection = false;
  for (const line of config.split(/\r?\n/)) {
    const section = /^\s*\[([^\] \t"]+)/.exec(line)?.[1]?.toLowerCase();
    if (section) blockedSection = UNSAFE_GIT_CONFIG_SECTIONS.has(section);
    if (blockedSection) continue;
    if (/^\s*(?:hooksPath|fsmonitor|sshCommand|editor|pager)\s*=/i.test(line)) {
      continue;
    }
    output.push(line);
  }
  return `${output.join("\n").trimEnd()}\n`;
}

async function sanitizeGitMetadata(snapshotRoot: string): Promise<void> {
  const gitRoot = join(snapshotRoot, ".git");
  await rm(join(gitRoot, "hooks"), { recursive: true, force: true });

  const sanitizeConfig = async (path: string): Promise<void> => {
    try {
      const config = await readFile(path, "utf8");
      await writeFile(path, sanitizeGitConfigText(config), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };
  await sanitizeConfig(join(gitRoot, "config"));

  // Nested submodule repositories live under .git/modules/**. Only traverse
  // directory structure that can contain another repository root; object and
  // ref stores may contain millions of files and never contain config files.
  const walkModules = async (directory: string): Promise<void> => {
    await sanitizeConfig(join(directory, "config"));
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    );
    for (const entry of entries) {
      if (
        entry.isDirectory() &&
        !["hooks", "logs", "objects", "refs"].includes(entry.name)
      ) {
        await walkModules(join(directory, entry.name));
      }
    }
  };
  await walkModules(join(gitRoot, "modules"));
}

function pathIsWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

async function cloneWorkspace(
  workspaceRoot: string,
  snapshotRoot: string
): Promise<void> {
  try {
    if (process.platform === "darwin") {
      await execFileAsync(
        "/bin/cp",
        ["-c", "-R", "-p", `${workspaceRoot}${sep}.`, snapshotRoot],
        { maxBuffer: 8 * 1024 * 1024 }
      );
      return;
    }
    await execFileAsync(
      "cp",
      ["-a", "--reflink=auto", `${workspaceRoot}${sep}.`, snapshotRoot],
      { maxBuffer: 8 * 1024 * 1024 }
    );
    return;
  } catch {
    // A real independent copy is slower but safe. Never use --link-dest or
    // hard-link fallbacks for a writable verifier snapshot.
  }

  await copyTree(workspaceRoot, snapshotRoot, {
    recursive: true,
    preserveTimestamps: true,
    force: true,
  });
}

async function findFirstRegularFile(directory: string): Promise<string | null> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isFile()) return path;
    if (entry.isDirectory()) {
      const nested = await findFirstRegularFile(path);
      if (nested) return nested;
    }
  }
  return null;
}

async function assertNoHardlinkedFiles(
  workspaceRoot: string,
  snapshotRoot: string
): Promise<void> {
  const snapshotFile = await findFirstRegularFile(snapshotRoot);
  if (!snapshotFile) return;
  const rel = relative(snapshotRoot, snapshotFile);
  const sourceFile = join(workspaceRoot, rel);
  const [sourceStat, snapshotStat] = await Promise.all([
    stat(sourceFile),
    stat(snapshotFile),
  ]);
  if (
    sourceStat.dev === snapshotStat.dev &&
    sourceStat.ino === snapshotStat.ino
  ) {
    throw new Error("Snapshot copy produced writable hard links.");
  }
}

async function assertNoEscapingSymlinks(snapshotRoot: string): Promise<void> {
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const fileStat = await lstat(path);
      if (fileStat.isSymbolicLink()) {
        const target = await readlink(path);
        const targetPath = isAbsolute(target)
          ? resolve(target)
          : resolve(dirname(path), target);
        if (!pathIsWithin(snapshotRoot, targetPath)) {
          throw new Error(
            `Snapshot contains a symlink that escapes the isolated root: ${relative(snapshotRoot, path)}`
          );
        }
      } else if (fileStat.isDirectory()) {
        await walk(path);
      }
    }
  };
  await walk(snapshotRoot);
}

async function assertIndependentGitMetadata(
  snapshotRoot: string
): Promise<void> {
  const gitPath = join(snapshotRoot, ".git");
  try {
    const gitStat = await lstat(gitPath);
    if (!gitStat.isDirectory()) {
      throw new Error(
        "Linked-worktree .git files are not yet supported by protected verification snapshots."
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function removeSnapshotPath(
  path: string,
  expectedPrefix: string
): Promise<void> {
  const base = path.slice(path.lastIndexOf(sep) + 1);
  if (!base.startsWith(expectedPrefix)) {
    throw new Error(`Refusing to remove unexpected verification path: ${path}`);
  }
  await rm(path, { recursive: true, force: true });
}

export async function createVerificationSnapshot(
  workspacePath: string
): Promise<VerificationSnapshot> {
  const workspaceRoot = await realpath(workspacePath);
  if (!BaseSandboxManager.isSupportedPlatform()) {
    throw new Error("OS sandbox isolation is unsupported on this platform.");
  }
  const dependencyCheck = BaseSandboxManager.checkDependencies();
  if (dependencyCheck.errors.length > 0) {
    throw new Error(
      `OS sandbox isolation dependencies are unavailable: ${dependencyCheck.errors.join("; ")}`
    );
  }

  const parent = dirname(workspaceRoot);
  let lastError: unknown;
  for (let attempt = 1; attempt <= COPY_ATTEMPTS; attempt += 1) {
    const snapshotRoot = await mkdtemp(join(parent, SNAPSHOT_PREFIX));
    const tempRoot = await mkdtemp(join(parent, TEMP_PREFIX));
    try {
      const mainBefore = await fingerprintWorkspace(workspaceRoot);
      await cloneWorkspace(workspaceRoot, snapshotRoot);
      await mkdir(tempRoot, { recursive: true, mode: 0o700 });
      await assertNoHardlinkedFiles(workspaceRoot, snapshotRoot);
      await assertNoEscapingSymlinks(snapshotRoot);
      await assertIndependentGitMetadata(snapshotRoot);
      const [snapshotBefore, mainAfter] = await Promise.all([
        fingerprintWorkspace(snapshotRoot),
        fingerprintWorkspace(workspaceRoot),
      ]);
      if (
        mainBefore.revision !== snapshotBefore.revision ||
        mainBefore.revision !== mainAfter.revision
      ) {
        throw new Error(
          "Workspace changed while the verification snapshot was being created."
        );
      }
      const redactedPaths = await redactSensitiveSnapshotFiles(snapshotRoot);
      await sanitizeGitMetadata(snapshotRoot);
      const integrityRevision = (await fingerprintWorkspace(snapshotRoot))
        .revision;

      return {
        workspaceRoot,
        snapshotRoot,
        tempRoot,
        revision: mainBefore.revision,
        integrityRevision,
        redactedPaths,
        async cleanup() {
          await Promise.all([
            removeSnapshotPath(snapshotRoot, SNAPSHOT_PREFIX),
            removeSnapshotPath(tempRoot, TEMP_PREFIX),
          ]);
        },
      };
    } catch (error) {
      lastError = error;
      await Promise.allSettled([
        removeSnapshotPath(snapshotRoot, SNAPSHOT_PREFIX),
        removeSnapshotPath(tempRoot, TEMP_PREFIX),
      ]);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Unable to create a stable verification snapshot.");
}
