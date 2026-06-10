/**
 * Installs the git prepare-commit-msg hook that appends Claude attribution
 * trailers to commit messages (ant-only, gated behind feature('COMMIT_ATTRIBUTION')).
 *
 * Split into its own module so it can be tree-shaken out of external builds and
 * reached exclusively via dynamic import() behind the feature flag (see
 * worktree.ts, which installs the hook into freshly-created worktrees).
 *
 * The hook script is intentionally a thin shell wrapper: it shells out to the
 * running CLI executable, passing the commit-message file path git provides as
 * $1. Heavy lifting (computing the trailer) lives in the CLI itself. The hook
 * is best-effort — any failure inside it must not block the commit, so the
 * wrapper swallows errors.
 */
import { chmod, writeFile } from 'fs/promises'
import { join } from 'path'
import { gitExe } from './git.js'
import { execFileNoThrowWithCwd } from './execFileNoThrow.js'
import { getFsImplementation } from './fsOperations.js'
import { logForDebugging } from './debug.js'
import { logError } from './log.js'

const HOOK_FILENAME = 'prepare-commit-msg'

/**
 * Marker line embedded in the generated hook so we can recognize (and safely
 * overwrite) a hook we previously installed without clobbering a user's own.
 */
const HOOK_MARKER = '# claude-code:attribution'

/**
 * Resolve the absolute path to the running CLI executable so the hook can
 * re-invoke it. Falls back to argv[1] (the entry script) when execPath isn't
 * the bundled binary.
 */
function resolveCliExecutable(): string {
  return process.argv[1] ?? process.execPath
}

/**
 * Build the prepare-commit-msg hook script.
 *
 * git invokes this hook with the commit-message file path as $1. We forward it
 * to the CLI's attribution entrypoint. Errors are swallowed (|| true) so a
 * broken or unavailable CLI never blocks a commit.
 */
function buildHookScript(cliExecutable: string): string {
  return [
    '#!/bin/sh',
    HOOK_MARKER,
    '# Appends Claude Code attribution trailers to the commit message.',
    '# Best-effort: never blocks a commit on failure.',
    `"${cliExecutable}" --attribution-commit-msg "$1" >/dev/null 2>&1 || true`,
    '',
  ].join('\n')
}

/**
 * Resolve the hooks directory for the given worktree. When an explicit
 * hooksDir is supplied (the worktree-local .husky), use it verbatim; otherwise
 * ask git where hooks live for this worktree.
 */
async function resolveHooksDir(
  worktreePath: string,
  hooksDir: string | undefined,
): Promise<string | null> {
  if (hooksDir) {
    return hooksDir
  }

  const result = await execFileNoThrowWithCwd(
    gitExe(),
    ['rev-parse', '--git-path', 'hooks'],
    { cwd: worktreePath, timeout: 5000 },
  )
  if (result.code !== 0 || !result.stdout.trim()) {
    return null
  }

  const resolved = result.stdout.trim()
  // git may echo a path relative to the worktree root; make it absolute.
  return resolved.startsWith('/') ? resolved : join(worktreePath, resolved)
}

/**
 * Install (or refresh) the prepare-commit-msg attribution hook in a worktree.
 *
 * Idempotent: if a hook with our marker already exists it is rewritten; if a
 * foreign hook exists we leave it untouched (don't clobber the user's hook).
 *
 * @param worktreePath Absolute path to the worktree root.
 * @param hooksDir Optional worktree-local hooks directory (e.g. the worktree's
 *   .husky). When omitted, resolved via `git rev-parse --git-path hooks`.
 */
export async function installPrepareCommitMsgHook(
  worktreePath: string,
  hooksDir?: string,
): Promise<void> {
  const fs = getFsImplementation()

  const targetDir = await resolveHooksDir(worktreePath, hooksDir)
  if (!targetDir) {
    logForDebugging(
      `Attribution: could not resolve hooks dir for ${worktreePath}`,
    )
    return
  }

  const hookPath = join(targetDir, HOOK_FILENAME)

  // Don't clobber a foreign prepare-commit-msg hook the user already owns.
  let existing: string | null = null
  try {
    existing = fs.readFileSync(hookPath, { encoding: 'utf8' })
  } catch {
    // Missing hook — safe to create.
  }
  if (existing !== null && !existing.includes(HOOK_MARKER)) {
    logForDebugging(
      `Attribution: leaving existing non-attribution hook at ${hookPath}`,
    )
    return
  }

  const script = buildHookScript(resolveCliExecutable())
  if (existing === script) {
    return
  }

  try {
    await fs.mkdir(targetDir, { mode: 0o755 })
    // writeFile mode is masked by umask; chmod afterwards guarantees +x.
    await writeFile(hookPath, script, { encoding: 'utf8', mode: 0o755 })
    await chmod(hookPath, 0o755)
    logForDebugging(
      `Attribution: installed prepare-commit-msg hook at ${hookPath}`,
    )
  } catch (error) {
    logError(error as Error)
  }
}
