# AGENTS.md — Fexor Code workspace guide

Instructions for coding agents (Codex / GPT, Kimi CLI, and other non-Claude
agents) working in this repository. This mirrors [CLAUDE.md](CLAUDE.md); for
humans, start with [README.md](README.md).

## What this repo is

`fexor-code` is a clean, buildable Bun/TypeScript fork of Anthropic's Claude Code
CLI, reconstructed from the publicly-exposed source snapshot — telemetry
stripped, prompt-level guardrails removed, experimental feature flags unlocked,
and **13 previously-broken flags reconstructed**. Tracks upstream **2.1.312**
(2026-10-29) with bounded-context ports and red-team-safe launcher defaults.
See [README.md](README.md) and [docs/UPSTREAM-2.1.309-DELTA.md](docs/UPSTREAM-2.1.309-DELTA.md).

## Build & run

| Task           | Command                                     |
| -------------- | ------------------------------------------- |
| Install deps   | `bun install`                               |
| Stable build   | `bun run build` → `./cli` (5 default flags) |
| Full dev build | `bun run build:dev:full` → `./cli-dev`      |
| Custom flags   | `bun run ./scripts/build.ts --feature=FLAG` |

Full build ~4 s. Binaries are git-ignored.

## Orientation

- Entry: `src/entrypoints/cli.tsx` → `src/main.tsx` → `src/setup.ts` → `src/screens/REPL.tsx`
- Turn loop: `src/query.ts` / `src/QueryEngine.ts`
- Registries: `src/commands.ts`, `src/tools.ts`, `src/tasks.ts`
- `feature('NAME')` is a compile-time `bun:bundle` macro chosen by `scripts/build.ts`.

## Reconstructing a broken flag

Read the `feature('X')`-gated call sites for exact exports/signatures, write the
minimal matching file(s), verify with `bun run ./scripts/build.ts --dev --feature=X`,
resolve cascading siblings, then add the flag to `fullExperimentalFeatures` in
`scripts/build.ts`. Full guide: [CONTRIBUTING.md](CONTRIBUTING.md).

## Conventions

- Conventional Commits. ESM with `.js` specifiers; tools via `buildTool`; Zod v4.
- Simplicity first; surgical changes; match existing style.
- No telemetry, no callbacks home. Never commit `.env*`, keys, or tokens.
- Do not commit `tmp/`, `.env*`, `graphify-out/`, or `scripts/eval/results/`.
- All launchers except Fugu append `prompts/autonomy-system-prompt.md` unless `FEXOR_AUTONOMY_PROMPT=0`.
- All launchers source `scripts/fexor-launcher-env.inc.sh` (Windows: `windows/fexor-launcher-env.ps1`) for shared, overridable defaults.

---

Maintained by **Profexor**.
