# CLAUDE.md — Fexor Code workspace guide

Guidance for AI coding agents (Claude Code and others) working in this repository.
For humans, start with [README.md](README.md).

## What this repo is

`fexor-code` is a clean, buildable Bun/TypeScript fork of Anthropic's Claude Code
CLI, reconstructed from the publicly-exposed source snapshot. Telemetry is
stripped, prompt-level guardrails removed, and experimental feature flags are
unlocked — including **13 flags reconstructed** from missing source files. See
[README.md](README.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Build & run

| Task            | Command                                                         |
| --------------- | --------------------------------------------------------------- |
| Install deps    | `bun install`                                                   |
| Stable build    | `bun run build` → `./cli`                                       |
| Full dev build  | `bun run build:dev:full` → `./cli-dev` (all experimental flags) |
| Custom flags    | `bun run ./scripts/build.ts --feature=FLAG`                     |
| Run from source | `bun run dev`                                                   |

A full build is ~4 seconds. Binaries (`cli`, `cli-dev`, `dist/`) are git-ignored.

## Architecture (orientation)

- **Entry**: `src/entrypoints/cli.tsx` → `src/main.tsx` (bootstrap) → `src/setup.ts` → `src/screens/REPL.tsx`
- **Turn loop**: `src/query.ts` / `src/QueryEngine.ts`
- **Registries**: `src/commands.ts` (slash commands), `src/tools.ts` (tools), `src/tasks.ts` (background tasks)
- **Feature flags**: `feature('NAME')` is a compile-time `bun:bundle` macro; `scripts/build.ts` selects which flags compile in. Full map in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Reconstructing a broken flag

The snapshot is missing source files for many flags. To restore one: read the
`feature('X')`-gated call sites for the exact exports/signatures, write the
minimal file(s) to match, verify with `bun run ./scripts/build.ts --dev --feature=X`,
resolve any cascading missing siblings, then add the flag to
`fullExperimentalFeatures` in `scripts/build.ts`. Full guide: [CONTRIBUTING.md](CONTRIBUTING.md).

## Coding discipline

Behavioral guidelines to reduce common mistakes. For trivial tasks, use judgment.

### 1. Think before coding

State assumptions explicitly; if uncertain, ask. Present multiple interpretations
rather than silently picking one. If a simpler approach exists, say so.

### 2. Simplicity first

Minimum code that solves the problem. No features beyond what was asked, no
single-use abstractions, no speculative configurability, no error handling for
impossible cases. If 200 lines could be 50, rewrite it.

### 3. Surgical changes

Touch only what you must. Don't "improve" adjacent code or refactor what isn't
broken. Match existing style. Remove only the orphans your own change created;
mention pre-existing dead code rather than deleting it unprompted.

### 4. Goal-driven execution

Turn tasks into verifiable goals ("add validation" → "write tests for invalid
inputs, then make them pass"). For multi-step work, state a brief plan with a
verify step for each.

## Conventions

- Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`).
- ESM with `.js` import specifiers resolving to `.ts`/`.tsx`; tools via `buildTool`; Zod v4.
- No telemetry, no callbacks home. Never commit `.env*`, keys, or tokens.

## Agent skills

This repo is wired for Matt Pocock's engineering skills. Three files govern how they behave here:

### Issue tracker

Issues live in GitHub at `jennofrie/fexor-code` (via `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles map 1:1 to GitHub labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: `CONTEXT.md` + `docs/adr/` at the repo root, created lazily by `/domain-modeling`. See `docs/agents/domain.md`.

### Module boundaries

Packages are deep modules — see `src/packages/README.md` before adding or importing one. _(Not yet present; scaffolded in Phase 2 module extraction. `lint:boundaries` runs dependency-cruiser in report-only mode meanwhile.)_

---

Maintained by **Profexor**.
