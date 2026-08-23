# Changelog

All notable changes to **Fexor Code** are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project does not yet follow semantic versioning (it tracks the upstream
Claude Code snapshot version, currently `2.1.87`).

## [Unreleased]

### Removed — Repository cleanup

- Removed two obsolete provider-specific launchers and their documentation references.
- Removed an orphaned training-pipeline appendix that described files and dependencies never tracked by this repository.

### Added — Shared autonomy system prompt

- New `prompts/autonomy-system-prompt.md`: concise “answer the request, don’t moralize, assume authorized research” addendum (same policy GLM already used).
- Supported third-party launchers, except Fugu, append it by default.
- Shared helper: `scripts/fexor-append-autonomy.inc.sh`. Opt out with `FEXOR_AUTONOMY_PROMPT=0` or `--append-system-prompt-file`. This is a launcher addendum only — it does not change model weights or restore Anthropic cyber-risk blocks (`CYBER_RISK_INSTRUCTION` stays empty).

### Added — Opt-in GLM coding verification harness

- `FEXOR_CODING_HARNESS=1 ./launch-glm.sh` enables the verifier agent, coding-discipline prompt, and LSP settings. Off by default. See `docs/VERIFICATION_CONTRACT.md`.

### Changed — DeepSeek launcher

- Flash effort floor is **high** (not max) to avoid stalling; Pro stays **max**. Select Flash with `--model deepseek-v4-flash`. Default hosted model remains Pro.

### Added — Claude Sonnet 5 support

- Added Claude Sonnet 5 (`claude-sonnet-5`) to the model registry, first-party Sonnet default, `/model` picker, public display names, pricing, commit attribution, hook examples, and bundled agent templates.
- Configured Sonnet 5 as native 1M context with no `[1m]` suffix or context beta required, plus 32K default / 128K upper output tokens.
- Added Sonnet 5 adaptive-thinking, effort, structured-output, context-management, and sampling-parameter safeguards so runtime requests avoid removed manual thinking budgets and non-default sampling parameters.

### Added — Reconstructed feature flags (13)

The leaked source snapshot referenced feature flags whose implementation files
were missing, so enabling them broke the build. These were rebuilt to their
exact existing call-site contracts, verified per-flag, and shipped in `cli-dev`.

**Wave 1**

- `BG_SESSIONS` — background-session CLI subcommands (`ps`/`logs`/`attach`/`kill`) and `--bg`. _Runtime-verified via `cli ps`._
- `FORK_SUBAGENT` — `/fork` conversation branching.
- `MONITOR_TOOL` — watch-a-command Monitor tool + background task + UI.
- `MCP_SKILLS` — skills sourced from MCP `skill://` resources.
- `BUDDY` — `/buddy` terminal companion.
- `AUTO_THEME` — live light/dark terminal detection via OSC 11.
- `COMMIT_ATTRIBUTION` — commit/PR attribution trailers + hooks.
- `CONTEXT_COLLAPSE` — `CtxInspect` tool over the context-collapse subsystem.

**Wave 2**

- `HISTORY_SNIP` — `Snip` tool + `/force-snip` to drop history ranges. _Backed by the existing `snipCompact` services._
- `TEMPLATES` — `new`/`list`/`reply` job CLI subcommands. _Runtime-verified via `cli list`._
- `REACTIVE_COMPACT` — 413 / prompt-too-long recovery compaction.
- `RUN_SKILL_GENERATOR` — bundled skill that scaffolds new skills.
- `WEB_BROWSER_TOOL` — fetch-and-read web tool (dependency-light, no new packages).

`dev-full` now compiles **49 flags** (up from 36).

### Added — Provider launchers & tuning

- Tuned per-provider launchers for DeepSeek V4-Pro, Qwen 3.7-Max, GPT-5.4/5.5, and Claude Opus 4.8 — each maximizing its true context window (up to 1M) and tool-use fidelity.
- Renamed the DeepSeek launcher from `launch.sh` to `launch-deepseek.sh` and defaulted it to max effort with adaptive thinking.
- `launch-gpt.sh` now defaults to GPT-5.5 (switchable), maps `max` effort to `xhigh`, sets verbosity to `medium`, and accounts the correct context window per model.
- Third-party launchers now set `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` and `DISABLE_INTERLEAVED_THINKING=1` to strip Anthropic-proprietary betas / experimental tool-schema fields that core-Messages endpoints reject.

### Changed — Source patches (`src/utils/context.ts`)

- `CLAUDE_CODE_MAX_CONTEXT_TOKENS` is now honored in external builds (was gated to `USER_TYPE === 'ant'`), so third-party 1M-context models budget correctly instead of defaulting to a 200K window. It remains a purely client-side budgeting value and is never sent to any provider.
- Added output-token entries for Opus 4.7/4.8 (64K default / 128K upper) — the latest Claude was previously capped at 32K output by an outdated table.

### Changed — Cyber-risk Read injection removed

- Removed the hardcoded `CYBER_RISK_MITIGATION_REMINDER` (plus its `MITIGATION_EXEMPT_MODELS` gate and the now-unused `model.js` import) that was appended to every `Read` tool result. Inherited from the upstream Anthropic snapshot, it had survived the "guardrails removed" fork despite the stated posture — it is now actually stripped. File reads return content with no trailing reminder block; no launcher or other tool is affected. Verified absent from both `cli` and `cli-dev` after rebuild; both binaries boot clean.

### Documentation

- Rewrote `README.md` (architecture/flag/provider diagrams, reconstruction status, badges).
- README launcher table now includes GLM, DeepSeek Flash, and the shared autonomy addendum.
- Added `docs/ARCHITECTURE.md`, `CONTRIBUTING.md`, `SECURITY.md`, `docs/VERIFICATION_CONTRACT.md`, this changelog, and GitHub issue/PR templates.
- Refreshed `FEATURES.md` to ground-truth (88 source flags; 49 shipped).

## [2.1.87] — Initial fork

- Reconstructed, buildable Bun/TypeScript workspace from the Claude Code source snapshot.
- Telemetry stripped, prompt-level guardrails removed, experimental flags unlocked.
- Five model providers (Anthropic, OpenAI Codex, AWS Bedrock, Google Vertex, Anthropic Foundry).

---

Maintained by **Profexor**.
