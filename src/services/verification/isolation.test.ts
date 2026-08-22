import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "child_process";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { fingerprintWorkspace } from "./contract.js";
import { SandboxManager } from "../../utils/sandbox/sandbox-adapter.js";
import { createVerificationSnapshot } from "./isolation.js";
import {
  assertVerificationReadPath,
  getVerificationSandboxConfig,
  getVerificationSubprocessEnv,
} from "./runtimeIsolation.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await SandboxManager.reset();
  await Promise.allSettled(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function makeDirtyGitWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "fexor-isolation-test-"));
  roots.push(root);
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@example.invalid"], {
    cwd: root,
  });
  await execFileAsync("git", ["config", "user.name", "Fexor Test"], {
    cwd: root,
  });
  await writeFile(join(root, "staged.txt"), "base staged\n");
  await writeFile(join(root, "working.txt"), "base working\n");
  await writeFile(join(root, ".gitignore"), ".env\n");
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-qm", "base"], { cwd: root });

  await writeFile(join(root, "staged.txt"), "staged mutation\n");
  await execFileAsync("git", ["add", "staged.txt"], { cwd: root });
  await writeFile(join(root, "working.txt"), "working mutation\n");
  await mkdir(join(root, "untracked", "nested"), { recursive: true });
  await writeFile(join(root, "untracked", "nested", "data.txt"), "untracked\n");
  await chmod(join(root, "working.txt"), 0o755);
  return root;
}

describe("protected verification snapshot", () => {
  test("scrubs credential-shaped environment variables and relocates HOME", () => {
    const sanitized = getVerificationSubprocessEnv(
      {
        PATH: "/usr/bin",
        SAFE_FLAG: "yes",
        ANTHROPIC_API_KEY: "secret",
        DATABASE_URL: "postgres://secret",
        MY_ACCESS_TOKEN: "secret",
        HTTPS_PROXY: "https://credential@example.invalid",
        NODE_OPTIONS: "--require=/tmp/untrusted.js",
      },
      "/tmp/verifier-home"
    );
    expect(sanitized.PATH).toBe("/usr/bin");
    expect(sanitized.SAFE_FLAG).toBe("yes");
    expect(sanitized.ANTHROPIC_API_KEY).toBeUndefined();
    expect(sanitized.DATABASE_URL).toBeUndefined();
    expect(sanitized.MY_ACCESS_TOKEN).toBeUndefined();
    expect(sanitized.HTTPS_PROXY).toBeUndefined();
    expect(sanitized.NODE_OPTIONS).toBeUndefined();
    expect(sanitized.HOME).toBe("/tmp/verifier-home");
    expect(sanitized.TMPDIR).toBe("/tmp/verifier-home");
    expect(sanitized.RUSTUP_HOME).toContain(".rustup");
  });

  test("preserves dirty state and never shares writable inodes", async () => {
    const root = await makeDirtyGitWorkspace();
    const before = await fingerprintWorkspace(root);
    const snapshot = await createVerificationSnapshot(root);
    try {
      expect(snapshot.revision).toBe(before.revision);
      expect(snapshot.integrityRevision).toBe(before.revision);
      expect((await fingerprintWorkspace(snapshot.snapshotRoot)).revision).toBe(
        before.revision
      );

      const sourceFile = join(root, "working.txt");
      const snapshotFile = join(snapshot.snapshotRoot, "working.txt");
      const [sourceStat, snapshotStat] = await Promise.all([
        lstat(sourceFile),
        lstat(snapshotFile),
      ]);
      expect(
        sourceStat.dev === snapshotStat.dev &&
          sourceStat.ino === snapshotStat.ino
      ).toBeFalse();

      await writeFile(snapshotFile, "verifier attempted mutation\n");
      expect(await readFile(sourceFile, "utf8")).toBe("working mutation\n");
      expect((await fingerprintWorkspace(root)).revision).toBe(before.revision);
      expect(
        (await fingerprintWorkspace(snapshot.snapshotRoot)).revision
      ).not.toBe(before.revision);
    } finally {
      await snapshot.cleanup();
    }
  });

  test("removes credential files and unsafe local Git configuration", async () => {
    const root = await makeDirtyGitWorkspace();
    await writeFile(join(root, ".env"), "TEST_ONLY_SECRET=not-a-real-secret\n");
    await execFileAsync(
      "git",
      [
        "remote",
        "add",
        "origin",
        "https://user:token@example.invalid/repo.git",
      ],
      { cwd: root }
    );
    const hook = join(root, ".git", "hooks", "pre-commit");
    await writeFile(hook, "#!/bin/sh\nexit 1\n");
    await chmod(hook, 0o755);

    const snapshot = await createVerificationSnapshot(root);
    try {
      expect(snapshot.redactedPaths).toContain(".env");
      await expect(
        readFile(join(snapshot.snapshotRoot, ".env"))
      ).rejects.toThrow();
      const config = await readFile(
        join(snapshot.snapshotRoot, ".git", "config"),
        "utf8"
      );
      expect(config).not.toContain("token@example.invalid");
      expect(config).not.toContain("[remote");
      await expect(
        lstat(join(snapshot.snapshotRoot, ".git", "hooks"))
      ).rejects.toThrow();
      expect((await fingerprintWorkspace(snapshot.snapshotRoot)).revision).toBe(
        snapshot.integrityRevision
      );
    } finally {
      await snapshot.cleanup();
    }
  });

  test("blocks reads outside the snapshot and temp roots", async () => {
    const root = await makeDirtyGitWorkspace();
    const snapshot = await createVerificationSnapshot(root);
    try {
      const context = {
        verificationRole: "verifier" as const,
        verificationIsolation: {
          workspaceRoot: snapshot.workspaceRoot,
          snapshotRoot: snapshot.snapshotRoot,
          tempRoot: snapshot.tempRoot,
        },
      };
      await expect(
        assertVerificationReadPath(context, join(root, "working.txt"))
      ).rejects.toThrow("outside the isolated snapshot");
      await expect(
        assertVerificationReadPath(
          context,
          join(snapshot.snapshotRoot, "working.txt")
        )
      ).resolves.toBeUndefined();
    } finally {
      await snapshot.cleanup();
    }
  });

  test("fails closed when a copied symlink escapes the snapshot", async () => {
    const root = await makeDirtyGitWorkspace();
    const outside = await mkdtemp(join(tmpdir(), "fexor-isolation-outside-"));
    roots.push(outside);
    await symlink(join(outside, "secret.txt"), join(root, "escape-link"));
    await expect(createVerificationSnapshot(root)).rejects.toThrow(
      "symlink that escapes"
    );
  });

  test("forces the OS sandbox even when the user sandbox setting is off", async () => {
    const root = await makeDirtyGitWorkspace();
    const snapshot = await createVerificationSnapshot(root);
    const isolation = {
      workspaceRoot: snapshot.workspaceRoot,
      snapshotRoot: snapshot.snapshotRoot,
      tempRoot: snapshot.tempRoot,
    };
    const release = await SandboxManager.acquireCustomConfig(
      getVerificationSandboxConfig(isolation)
    );
    try {
      const config = getVerificationSandboxConfig(isolation);
      expect(
        config.filesystem.allowRead.some(
          (path) =>
            snapshot.workspaceRoot === path ||
            snapshot.workspaceRoot.startsWith(`${path}/`)
        )
      ).toBeFalse();
      const blockedRead = await SandboxManager.wrapWithSandbox(
        `cat ${JSON.stringify(join(root, "working.txt"))}`,
        "/bin/zsh",
        config
      );
      await expect(
        execFileAsync("/bin/zsh", ["-c", blockedRead], {
          cwd: snapshot.snapshotRoot,
        })
      ).rejects.toThrow();
      const blocked = await SandboxManager.wrapWithSandbox(
        `printf hacked > ${JSON.stringify(join(root, "working.txt"))}`,
        "/bin/zsh",
        config
      );
      await expect(
        execFileAsync("/bin/zsh", ["-c", blocked], {
          cwd: snapshot.snapshotRoot,
        })
      ).rejects.toThrow();
      expect(await readFile(join(root, "working.txt"), "utf8")).toBe(
        "working mutation\n"
      );

      const allowedPath = join(snapshot.tempRoot, "probe.txt");
      const allowed = await SandboxManager.wrapWithSandbox(
        `printf allowed > ${JSON.stringify(allowedPath)}`,
        "/bin/zsh",
        config
      );
      await execFileAsync("/bin/zsh", ["-c", allowed], {
        cwd: snapshot.snapshotRoot,
      });
      expect(await readFile(allowedPath, "utf8")).toBe("allowed");

      const loopbackScript =
        "const http=require('http');const s=http.createServer((_q,r)=>r.end('loopback-ok'));s.listen(0,'127.0.0.1',async()=>{const r=await fetch('http://127.0.0.1:'+s.address().port);console.log(await r.text());s.close()})";
      const loopback = await SandboxManager.wrapWithSandbox(
        `node -e ${JSON.stringify(loopbackScript)}`,
        "/bin/zsh",
        config
      );
      const loopbackResult = await execFileAsync("/bin/zsh", ["-c", loopback], {
        cwd: snapshot.snapshotRoot,
      });
      expect(loopbackResult.stdout.trim()).toBe("loopback-ok");
    } finally {
      release();
      await SandboxManager.reset();
      await snapshot.cleanup();
    }
  });

  test("leases and restores the restrictive policy from a cold runtime", async () => {
    await SandboxManager.ensureInitializedForCustomConfig();
    const originalHosts =
      SandboxManager.getNetworkRestrictionConfig().allowedHosts;
    const originalLocalBinding = SandboxManager.getAllowLocalBinding();

    const root = await makeDirtyGitWorkspace();
    const snapshot = await createVerificationSnapshot(root);
    const config = getVerificationSandboxConfig({
      workspaceRoot: snapshot.workspaceRoot,
      snapshotRoot: snapshot.snapshotRoot,
      tempRoot: snapshot.tempRoot,
    });
    const release = await SandboxManager.acquireCustomConfig(config);
    try {
      expect(SandboxManager.getNetworkRestrictionConfig().allowedHosts).toEqual(
        ["localhost", "127.0.0.1"]
      );
      expect(SandboxManager.getAllowLocalBinding()).toBeTrue();
    } finally {
      release();
      await snapshot.cleanup();
    }
    expect(SandboxManager.getNetworkRestrictionConfig().allowedHosts).toEqual(
      originalHosts
    );
    expect(SandboxManager.getAllowLocalBinding()).toBe(originalLocalBinding);
  });
});
