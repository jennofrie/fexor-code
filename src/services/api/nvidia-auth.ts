import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

let cachedApiKey: string | undefined;

function readCredentialFile(path: string): string {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return "";
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) return "";
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * Resolve NVIDIA auth once, then remove any environment copy before tools or
 * hooks spawn child processes. On macOS the preferred path reads Keychain
 * directly. Linux uses a private 0600 credential file. Neither path requires
 * the launcher to export the credential.
 */
export function getNvidiaApiKey(): string {
  if (cachedApiKey !== undefined) return cachedApiKey;

  cachedApiKey = process.env.NVIDIA_API_KEY?.trim() || "";
  delete process.env.NVIDIA_API_KEY;
  if (cachedApiKey) return cachedApiKey;

  if (process.platform === "darwin") {
    try {
      cachedApiKey = execFileSync(
        "/usr/bin/security",
        ["find-generic-password", "-s", "nvidia_api_key", "-w"],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }
      ).trim();
    } catch {
      cachedApiKey = "";
    }
    if (cachedApiKey) return cachedApiKey;
  }

  const credentialFile =
    process.env.NVIDIA_API_KEY_FILE ||
    join(homedir(), ".config", "fexor-code", "nvidia_api_key");
  cachedApiKey = readCredentialFile(credentialFile);
  return cachedApiKey;
}
