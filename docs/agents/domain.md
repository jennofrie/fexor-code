# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the Fexor Code codebase.

## Layout: single-context

```
/
├── CONTEXT.md          ← glossary, created lazily by /domain-modeling
├── docs/adr/           ← architecture decision records
├── docs/agents/        ← this file + issue-tracker + triage-labels
└── src/
```

This is a single-context repo (one source tree, no monorepo packages yet). When `src/packages/` is introduced during Phase 2 module extraction, revisit whether a multi-context layout is warranted.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root — the project's ubiquitous language glossary.
- **`docs/adr/`** — ADRs that touch the area you're about to work in.

If either is absent, **proceed silently** — don't flag the absence. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates `CONTEXT.md` and ADRs lazily when terms or decisions actually get resolved.

## Use the glossary's vocabulary

When your output names a domain concept (issue title, refactor proposal, test name), use the term as defined in `CONTEXT.md`. The core harness vocabulary to keep stable: **Tool, Hook, Session, Subagent, Provider, PermissionMode, Worktree, Skill, MCP server**.

If the concept isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (...) — but worth reopening because…_
