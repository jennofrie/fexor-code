# CONTEXT — Fexor Code ubiquitous language

A glossary of the domain terms used in this harness. Kept free of implementation
detail — this is _language_, not spec. Ambiguous or contested terms are flagged
for resolution (the `/grilling` skill sharpens them).

## Stable terms

**Tool** — a capability the model can invoke during a turn. Declared as a typed
input schema; executed by the harness; the result is fed back into the
conversation. Examples: `Read`, `Edit`, `Bash`, `Grep`, `Agent`.

**Turn loop** — the cycle of _send messages to model → stream response →
dispatch tool calls → return tool results → repeat_ until the turn ends. The
spine of the harness. (Lives in `src/query.ts` today.)

**Session** — one conversation instance: its message history, accumulated tool
results, permission decisions, and UI state.

**Subagent** — an agent spawned inside a turn, with its own session and context
budget, dispatched to do isolated work and return a single result. Typed
(`general-purpose`, `Explore`, `Plan`, ...) and may run isolated in a worktree.

**Worktree** — an isolated git worktree a subagent can operate in, so its
changes don't touch the main working tree.

**Hook** — a lifecycle callback the harness executes on a specific event
(`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, ...). May run a shell
command, an LLM prompt, or an HTTP call; may block (exit 2) or observe.

**PermissionMode** — the gating posture for tool approvals: `auto`,
`manual`, `always`, `plan`. Determines whether a tool run prompts the user,
auto-approves, or is denied.

**MCP server** — a Model Context Protocol server the harness connects to
(stdio / SSE / HTTP / WebSocket) to expose extra tools, resources, or prompts.

**Skill** — a markdown-defined workflow invokable by `/name`. Either
model-invoked (auto-triggered by description) or user-invoked (typed). Lives in
`~/.claude/skills/` or `.claude/skills/`.

**Compaction** — summarizing and dropping older context when a session
approaches the model's context limit, preserving key facts in a synthetic
boundary message.

**Snip** — a manual drop of a contiguous history range (distinct from
compaction, which is automatic and summarizing).

**Feature flag** — a compile-time `feature('NAME')` macro that gates
experimental code in or out of a build.

## Provider & Model (resolved 2026-07-26 via grill Q1)

**Provider** — the API _transport_: the wire shape, endpoint base URL, and auth
method used to reach a model. The seam that varies across `firstParty`/Anthropic,
Z.ai's Anthropic-compatible endpoint, Bedrock, Vertex, OpenAI-shape endpoints.
This is what `getAPIProvider()` returns. _A Provider **serves** Models._

**Model** — a specific served model: its ID (e.g. `glm-5.2[1m]`,
`glm-5.3[1m]`), its capabilities (thinking, max_effort), and its context
window. _A Model is **served by** exactly one Provider._ Selecting a Model
implicitly selects its serving Provider.

So **GLM-5.2 and GLM-5.3 are Models served by the Z.ai-Anthropic Provider** —
not Providers in their own right. The earlier operator phrase "the GLM
provider" is resolved to mean _the Model+Provider pair_, spelled out when
precision matters.
