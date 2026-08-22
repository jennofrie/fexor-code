# Coding-harness verification contract

The Fexor coding harness is an opt-in runtime contract for non-trivial coding
work. It is not a generic GrowthBook override and does not change the legacy
verification experiment when the harness is off.

## Enabling the harness

The launcher recognizes only the exact master value:

```sh
FEXOR_CODING_HARNESS=1 ./launch-glm.sh
```

With the switch absent or set to another value, the launcher retains its prior
environment, Air subagent default, autonomy prompt flag, empty settings-source
selection, and tool surface. A remotely enabled legacy verification experiment
can still expose its old background agent, but it cannot activate the Fexor
stop gate or isolation policy.

The enabled launcher defaults these independent parts on:

| Part                     | Default under master | Hard opt-out                        |
| ------------------------ | -------------------- | ----------------------------------- |
| Enforced verifier        | on                   | `FEXOR_ENABLE_VERIFICATION_AGENT=0` |
| Coding-discipline prompt | on                   | `FEXOR_ENABLE_CODING_PROMPT=0`      |
| LSP tool/plugin settings | on                   | `ENABLE_LSP_TOOL=0`                 |

Caller-provided `--append-system-prompt`, `--append-system-prompt-file`,
`--settings`, or `--setting-sources` arguments win. The launcher never passes
both append-prompt forms. Its default LSP settings enable only
`rust-analyzer-lsp@claude-plugins-official`; they do not load general user
settings. `rust-analyzer --version` must succeed and the plugin must already be
in the isolated `~/.fexor-code-glm` plugin cache. A rustup shim without the
component installed is treated as unavailable; install it with
`rustup component add rust-analyzer` (or `brew install rust-analyzer`).

## Contract lifecycle

One contract is bound to the main session, primary workspace, genuine human
request, and a content fingerprint:

```text
not_required ── qualifying mutation ──> required ── verifier starts ──> running
                                            ^                              |
                                            |                              v
                                      fix after FAIL <── fail         pass / partial
```

A new settled contract starts on the next genuine human prompt. A live
`required`, `running`, `fail`, `partial`, or internal-error contract instead
retains its identity and records subsequent human text as an amendment. Tool
results, stop-gate metadata, task notifications, and synthetic continuations
do not reset it.

Verification becomes required when any of these occurs:

- three or more distinct native file-tool writes;
- a write to a backend, API, server, infrastructure, package, lockfile,
  environment, or configuration path;
- a Bash or PowerShell command that cannot be proved read-only; or
- end-of-turn reconciliation finds a workspace revision change not accounted
  for by successful native file tools, including MCP or external edits.

Native mutation records are emitted only after successful Edit, Write, and
NotebookEdit operations and do not depend on checkpointing. A mutation after a
PASS, PARTIAL, waiver, or failed attempt invalidates that result. A main
workspace change while the verifier runs makes its verdict stale.

Git workspaces are fingerprinted from HEAD, staged and unstaged binary diffs,
index modes, and every non-ignored untracked file. Non-Git workspaces use a
bounded, full-content filesystem walk and carry a degraded note. If a stable
revision cannot be established, the contract fails closed.

## Trusted verifier

When enforcement is active, `verification` is a reserved built-in identity:

- user, project, and plugin agents cannot shadow it;
- only the main thread can invoke it;
- caller model, background, team, mode, isolation, and cwd overrides are
  rejected;
- it always uses the parent model, ignoring both the Agent tool model and
  `CLAUDE_CODE_SUBAGENT_MODEL`;
- every async-forcing route is disabled, so the parent waits inline;
- inherited MCP servers, external subagent hooks, skills, and automatic
  CLAUDE.md injection are disabled; and
- the only tools are Bash, Read, Glob, and Grep.

The harness owns the verifier prompt. Implementer-supplied text is marked as
untrusted notes and cannot narrow the original task or mutation scope. The
default wall-clock limit is ten minutes and can be lowered or raised, up to one
hour, with `FEXOR_VERIFICATION_TIMEOUT_MS`.

A verdict is accepted only when the final non-empty line is exactly one of:

```text
VERDICT: PASS
VERDICT: FAIL
VERDICT: PARTIAL
```

There must be exactly one `VERDICT:` line. Markdown, punctuation, duplicates,
or missing output fail closed. PASS additionally requires at least one
successfully completed Bash-tool check; a failed/denied invocation or reading
source alone is not sufficient.

## Snapshot protection

Before each attempt, Fexor creates a same-volume independent snapshot of the
exact main revision. APFS copy-on-write cloning is preferred; a reflink or full
independent copy is used elsewhere. Writable hard links, escaping symlinks,
linked-worktree `.git` files, unstable copies, and unsupported OS sandboxing
fail closed.

Credential-shaped files are removed from the snapshot, Git hooks are removed,
and credential, include, filter, remote, URL-rewrite, signing, diff, merge, and
other executable Git configuration is stripped. The verifier receives a
scrubbed environment with a private HOME and temp directory. Provider keys,
tokens, credentials, proxy variables, runtime injection variables, and Git
environment overrides are removed.

Verifier Bash always runs in the OS sandbox even if normal sandbox mode is off.
It can read the snapshot and narrowly approved local toolchain paths, write
only inside the disposable snapshot and verifier temp directory, bind
localhost, and reach only localhost/127.0.0.1. External network, Unix sockets,
PTYs, the real workspace, user configuration, and the normal home directory are
blocked. The
restrictive network policy is leased for the subprocess lifetime even if the
shared sandbox runtime was initialized earlier with a permissive policy.

After execution, Fexor confirms that the real workspace still matches the
bound revision and that tracked or non-ignored snapshot content still matches
the sanitized pre-run snapshot. The snapshot is then deleted. A stale main
revision is ignored and requires another attempt; snapshot mutation, timeout,
abort, malformed output, or isolation failure becomes an unverified terminal
result.

## Completion gate and bounded failure

The internal gate runs before extensible Stop hooks and only on the main
thread. `required` and `fail` inject a blocking meta-message so the model must
run verification or fix defects. `pass`, `not_required`, and an explicit human
waiver release the turn.

The gate never hot-loops indefinitely. Attempts and repeated stop blocks both
default to three (bounded by 10 via `FEXOR_VERIFICATION_MAX_ATTEMPTS` and
`FEXOR_VERIFICATION_MAX_STOP_BLOCKS`). PARTIAL, isolation/internal errors, a
running-state invariant failure, or exhausted limits terminate visibly as
`UNVERIFIED`; print/SDK mode also receives exit status 2. Provisional text-only
assistant completion messages are tombstoned before the gate continues or
terminates.

An interactive user can deliberately accept an unresolved revision by sending
the exact command shown in the terminal notice:

```text
WAIVE VERIFICATION <contract-id>
```

The waiver is revision-bound. Any subsequent workspace mutation requires
verification again.

## Known limits

- Enforcement is scoped to the primary cwd. A detected write outside it ends
  unverified because that path cannot be included in the protected snapshot.
- Linked Git worktrees currently fail snapshot creation rather than following
  their external `.git` metadata.
- Git fingerprints intentionally ignore ignored files. Writes to generated or
  dependency-cache files can affect local checks, although they occur only in
  the disposable snapshot and cannot damage the main workspace.
- Snapshot integrity is a final net-state comparison, not a system-call audit.
  A write that is perfectly reverted before exit is not retained as a mutation;
  the real workspace remains protected by the separate snapshot and OS sandbox.
- The verifier receives installed Rust/Bun executables but a private Cargo and
  configuration home. Checks that require downloading or reading dependencies
  absent from the project snapshot should report PARTIAL.
- The narrow trusted tool surface has no browser automation or external
  network. Browser-only or dependency-download-dependent checks should return
  PARTIAL, not invented evidence.
- Text already streamed to an external consumer cannot be physically
  retracted; the transcript receives a tombstone and the final result/exit code
  remains authoritative.
- Low-risk changes to fewer than three native files do not automatically
  require the verifier unless reconciliation finds an opaque write.
- Auto-compact breaker notifications are per query chain, because failure
  tracking resets when a new query chain starts.
- LSP startup is asynchronous. The harness exposes the tool while startup is
  pending so it can wait on first use; a failed server is hidden in subsequent
  tool assemblies. A tool already present in an assembled first-turn pool may
  instead return the normal initialization error.

## Evaluation

The locked paired evaluator is documented in
[`scripts/eval/README.md`](../scripts/eval/README.md). Its pilot and Stage B are
dry-run by default. Stage B cannot start until the user approves the committed
acceptance thresholds, and neither stage should be executed without accepting
the model-call budget. Candidate modules, CLIs, and Rust binaries are judged in
a second secret-scrubbed sandbox with the workspace read-only and the Fexor
repository/evaluator unreadable.
