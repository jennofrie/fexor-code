# Locked coding-harness evaluation

This evaluator compares five isolated arms: baseline, verifier-only, LSP-only,
prompt-only, and the full coding harness. The task workspace contains only the
seeded project. Hidden deterministic assertions remain in this directory and
run only after Fexor exits.

During an executed run, the runner copies `cli-dev`, the launcher, and the
required prompts into a temporary runtime. A macOS sandbox denies the child
access to this source repository and makes the copied runtime read-only. The
runner refuses execution on platforms where that lock cannot be established.
After the model exits, candidate modules, CLI programs, and Rust binaries run
in a separate sandbox: the task workspace is read-only, the evaluator and
Fexor repository are unreadable/unwritable, network is denied, API credentials
are removed from the environment, and HOME is a private temporary directory.
If `.env.glm` exists, Varlock injects only the GLM provider variables and
redacts piped output; otherwise the copied launcher uses its normal environment
or macOS Keychain lookup. Keychain/provider values are included in the runner's
in-memory redaction set but are never printed or written raw. Raw environment
values are never written to the manifest, and transcripts receive a second
redaction pass before persistence.

Commands:

```sh
# No model calls; inspect run counts, caps, and approval state.
bun scripts/eval/runner.ts plan

# 20 calls: 4 tasks x 5 arms. Still requires the explicit execution flag.
bun scripts/eval/runner.ts pilot --execute --max-budget-usd 2

# 216 calls. Refuses to start until acceptance.json records explicit approval.
bun scripts/eval/runner.ts stage-b --execute --max-budget-usd 2

# Regenerate the report from an existing append-only result set.
bun scripts/eval/runner.ts report --results-dir scripts/eval/results/main
```

Runs are sequential, deterministically shuffled, resumable, capped at ten
minutes, 30 turns, and 100,000 API task-budget tokens by default, and retried
once only for an infrastructure failure.
Infrastructure attempts remain in `runs.jsonl` with `discarded: true`; they are
never silently counted as task failures. Each result directory has an immutable
manifest. Use a new `--results-dir` when changing the binary, corpus, model,
thresholds, source diff, or run parameters.
The pilot exits non-zero if any scheduled run exhausts its one infrastructure
retry. The deterministic test suite also proves that all 24 seeded projects
fail their hidden checks before repair.

Before Stage B, review and deliberately approve `acceptance.json`. The default
threshold values are proposals, not an approval. The committed 24-task corpus
is useful for early development, but it is too small for broad or statistically
strong claims; expand it beyond 50 independently designed tasks before using
the report as public evidence of general competence.

The lock protects the local evaluator and runtime from the evaluated process.
It is not a secrecy claim against a model that has memorized a publicly
released corpus. Rotate or hold back tasks for externally reported benchmarks.
