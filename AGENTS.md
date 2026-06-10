# AGENTS.md — Fexor Code workspace guide

Instructions for coding agents (Codex / GPT, Kimi CLI, and other non-Claude
agents) working in this repository. This mirrors [CLAUDE.md](CLAUDE.md); for
humans, start with [README.md](README.md).

## What this repo is

`fexor-code` is a clean, buildable Bun/TypeScript fork of Anthropic's Claude Code
CLI, reconstructed from the publicly-exposed source snapshot — telemetry
stripped, prompt-level guardrails removed, experimental feature flags unlocked,
and **13 previously-broken flags reconstructed**. See [README.md](README.md) and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Build & run

| Task | Command |
|------|---------|
| Install deps | `bun install` |
| Stable build | `bun run build` → `./cli` |
| Full dev build | `bun run build:dev:full` → `./cli-dev` |
| Custom flags | `bun run ./scripts/build.ts --feature=FLAG` |

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

---

Maintained by **Profexor**.
