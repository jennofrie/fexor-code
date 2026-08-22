import { realpath } from "fs/promises";
import { homedir, tmpdir } from "os";
import { delimiter, isAbsolute, relative, resolve, sep } from "path";
import type {
  VerificationContextFields,
  VerificationIsolation,
} from "./types.js";

function pathIsWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

export async function assertVerificationReadPath(
  context: Pick<
    VerificationContextFields,
    "verificationRole" | "verificationIsolation"
  >,
  inputPath: string
): Promise<void> {
  if (context.verificationRole !== "verifier") return;
  const isolation = context.verificationIsolation;
  if (!isolation) {
    throw new Error("Verifier filesystem isolation context is missing.");
  }
  const candidate = isAbsolute(inputPath)
    ? resolve(inputPath)
    : resolve(isolation.snapshotRoot, inputPath);
  if (
    !pathIsWithin(isolation.snapshotRoot, candidate) &&
    !pathIsWithin(isolation.tempRoot, candidate)
  ) {
    throw new Error(
      `Verifier read blocked outside the isolated snapshot: ${inputPath}`
    );
  }

  try {
    const canonical = await realpath(candidate);
    if (
      !pathIsWithin(isolation.snapshotRoot, canonical) &&
      !pathIsWithin(isolation.tempRoot, canonical)
    ) {
      throw new Error(
        `Verifier read blocked through an escaping symlink: ${inputPath}`
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function getVerificationSandboxConfig(isolation: VerificationIsolation) {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  const userHome = homedir();
  const denyRead = [userHome, tmpdir(), isolation.workspaceRoot];
  if (configDir) denyRead.push(resolve(configDir));
  const allowRead = [
    isolation.snapshotRoot,
    isolation.tempRoot,
    resolve(userHome, ".rustup"),
    resolve(userHome, ".cargo", "bin"),
    resolve(userHome, ".cargo", "git"),
    resolve(userHome, ".cargo", "registry"),
    resolve(userHome, ".bun", "bin"),
  ];

  return {
    filesystem: {
      denyRead,
      allowRead: [...new Set(allowRead)],
      allowWrite: [isolation.snapshotRoot, isolation.tempRoot],
      denyWrite: [
        isolation.workspaceRoot,
        ...(configDir ? [resolve(configDir)] : []),
      ],
      allowGitConfig: false,
    },
    network: {
      allowedDomains: ["localhost", "127.0.0.1"],
      deniedDomains: [],
      allowUnixSockets: [],
      allowAllUnixSockets: false,
      allowLocalBinding: true,
    },
    allowPty: false,
  };
}

const SENSITIVE_ENV_NAME =
  /(token|secret|password|passwd|api[_-]?key|private[_-]?key|credential|authorization|cookie|oauth|bearer|access[_-]?key|database[_-]?url|dsn|jwt|session|signing)/i;
const UNSAFE_PROCESS_ENV_NAME =
  /^(?:BASH_ENV|ENV|ZDOTDIR|NODE_OPTIONS|BUN_OPTIONS|RUBYOPT|PERL5OPT|PYTHONPATH|LD_PRELOAD|DYLD_.+|SSH_.+|GIT_.+|KUBECONFIG|DOCKER_HOST|VAULT_.+|CLAUDE_CONFIG_DIR)$/i;

export function getVerificationSubprocessEnv(
  source: NodeJS.ProcessEnv = process.env,
  tempRoot?: string
): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (
      value === undefined ||
      SENSITIVE_ENV_NAME.test(name) ||
      UNSAFE_PROCESS_ENV_NAME.test(name)
    ) {
      continue;
    }
    if (/^(ANTHROPIC|OPENAI|AWS|AZURE|GOOGLE|GITHUB|GH|NPM)_/i.test(name)) {
      continue;
    }
    if (/^(HTTP|HTTPS|ALL)_PROXY$/i.test(name)) continue;
    sanitized[name] = value;
  }
  if (tempRoot) {
    const originalHome = homedir();
    sanitized.HOME = tempRoot;
    sanitized.TMPDIR = tempRoot;
    sanitized.TMP = tempRoot;
    sanitized.TEMP = tempRoot;
    sanitized.XDG_CONFIG_HOME = tempRoot;
    sanitized.XDG_CACHE_HOME = tempRoot;
    sanitized.CARGO_HOME = tempRoot;
    // rustup shims need the installed toolchain, but Cargo's mutable/config
    // home stays private so credentials and user config are not inherited.
    sanitized.RUSTUP_HOME = resolve(originalHome, ".rustup");
    sanitized.CLAUDE_CONFIG_DIR = tempRoot;
  }
  const originalHome = homedir();
  const allowedHomePathRoots = [
    resolve(originalHome, ".bun", "bin"),
    resolve(originalHome, ".cargo", "bin"),
  ];
  sanitized.PATH = (sanitized.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .filter((path) => {
      const absolute = resolve(path);
      return (
        !pathIsWithin(originalHome, absolute) ||
        allowedHomePathRoots.some((root) => pathIsWithin(root, absolute))
      );
    })
    .join(delimiter);
  sanitized.GIT_CONFIG_GLOBAL = "/dev/null";
  sanitized.GIT_CONFIG_NOSYSTEM = "1";
  sanitized.GIT_TERMINAL_PROMPT = "0";
  sanitized.NPM_CONFIG_USERCONFIG = "/dev/null";
  sanitized.FEXOR_VERIFICATION = "1";
  return sanitized;
}
