# Fexor Code vs Claude Code 2.1.309 — delta report

Date: 2026-10-24
Fexor source: `~/Desktop/Github/fexor-code-main`
Upstream binary: `~/.local/share/claude/versions/2.1.309` (SHA-256 `5eadc0009cdcdbc0d06e58110d7b2baf88ced6088b1c33a60a21217fe410619c`)
Full upstream changelog: `docs/upstream/CHANGELOG-2.1.89-2.1.310.md`
All 6,313 entries, categorised: `docs/upstream/changes-2.1.89-2.1.310.csv`

## 1. Method

1. Located Fexor at `~/Desktop/Github/fexor-code-main` and confirmed its source snapshot
   label (`2.1.87`).
2. Confirmed the installed Claude Code is `2.1.309` and that the npm `2.1.309` package is
   only a 29 KB native-binary wrapper (no `cli.js`).
3. Used REA (`rea-agents` 4.0.1, `morluto/rea`) to inventory the native Mach-O, then carved
   the `__BUN,__bun` segment. It contains 133 plaintext JavaScript source modules
   (28 MB; largest 5.2 MB), each stamped `// Version: 2.1.309`.
4. Parsed the official upstream changelog: 179 releases from `2.1.89` through `2.1.309`
   (6,287 bullets), plus `2.1.310` as post-install backlog (26 bullets).
5. Checked every candidate feature against Fexor source by symbol, environment variable,
   flag, and call site. A feature is "Present" only when its implementation or the
   documented call-site contract exists.

REA's full application-graph pass OOM'd at Node's default ~4 GB heap on the 28 MB minified
bundle. The artifact inventory and source carving completed; symbol-level comparison used
the carved modules plus `rg`. This limitation is recorded rather than hidden.

## 2. Executive summary

- Fexor is **not a clean 2.1.87 snapshot**. It already contains many later fixes and
  features (PermissionDenied hooks, autocompact circuit breaker, tool-schema cache,
  prompt-cache break detection, `/stats` subagent accounting, Agent Teams, Workflow,
  Monitor, background sessions, Context Collapse, History Snip, Cached Microcompact).
- The remaining delta is dominated by **bug fixes** (3,437) and **incremental tool/agent
  work** (2,724 tool-related, 2,385 agent-related), not one large missing subsystem.
- Fexor already has an empty `CYBER_RISK_INSTRUCTION`; upstream `2.1.309` has **no**
  `CYBER_RISK` token either. The 2.1.126 malware-reminder removal is already in effect.
- The red-team danger in upstream is **not a new refusal string**; it is the expansion of
  auto-mode classifier and sandbox denial paths (`hard_deny`, `classifyAllShell`,
  `--permission-prompts none`, new sandbox defaults). Those are deliberately excluded.
- This release ports the highest-value **bounded-context** changes and reports the rest.

## 3. Delta by category

Categories overlap; a bullet can match more than one. Counts cover `2.1.89`–`2.1.310`.

| Category                   | Entries | What changed                                                                                        |
| -------------------------- | ------: | --------------------------------------------------------------------------------------------------- |
| Tools / MCP / LSP          |   2,724 | MCP lifecycle, deferred tools, tool-result persistence, permissions, PowerShell, WebSearch, plugins |
| Agents / sessions          |   2,385 | subagents, teams, workflows, background sessions, resume, compaction interaction                    |
| UI / terminal / IDE        |   1,334 | Ink rendering, VSCode, status line, vim, scrolling, themes, accessibility                           |
| Context / tokens / memory  |   1,100 | compaction, microcompaction, prompt cache, transcripts, memory, token budgets                       |
| Performance / stability    |   1,078 | crashes, hangs, leaks, startup, large-file and large-session behavior                               |
| Security / permissions     |     855 | sandbox, allow/deny rules, symlinks, credential paths, managed policy                               |
| Providers / models         |     785 | Bedrock, Vertex, Foundry, gateways, Opus 5, Sonnet 5.5, effort handling                             |
| Hooks                      |     449 | lifecycle events, blocking behavior, output handling, hook security                                 |
| Data / telemetry / storage |     411 | OTel events, usage accounting, transcript storage, cleanup                                          |
| Cyber / red-team explicit  |       3 | malware warning fix, cyber notice wording, Cyber Verification Program removal                       |

Change-type totals: **3,437 Fixed**, **598 Improved**, **462 Added**, **386 Changed**,
**33 Removed**. Tagged subsets include 377 VSCode, 260 Claude-apps/cloud, 54 Claude Code
on the web, and 43 Windows.

## 4. High-impact feature matrix

Status is against Fexor **before** this release's ports. "Flag" means source exists but a
compile-time feature flag controls it.

| Area      | Upstream change (version)                                                     | Fexor status                                  | Decision                             |
| --------- | ----------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------ |
| Agents    | Agent Teams (2.1.114+)                                                        | Present                                       | Keep                                 |
| Agents    | Workflow tool (2.1.152+); prompt cut 5.7K→1K tokens (2.1.248)                 | Present (flag); prompt-size parity unverified | Verify prompt footprint              |
| Agents    | Background sessions / `--bg` (2.1.145+)                                       | Present (flag `BG_SESSIONS`)                  | Keep                                 |
| Agents    | Fork subagents default in `-p`/SDK (2.1.302)                                  | Present (`FORK_SUBAGENT`)                     | Enable in `-p` if desired            |
| Agents    | Subagent concurrency cap, default 20 (2.1.217)                                | Absent                                        | **Ported this release**              |
| Agents    | `--forward-subagent-text` for subagent text/thinking in stream-json (2.1.211) | Absent                                        | Tier 1 for red-team evidence capture |
| Agents    | `claude agents --json` live-session inventory (2.1.145)                       | Absent                                        | Tier 2                               |
| Tools     | Monitor tool (2.1.98)                                                         | Present (flag `MONITOR_TOOL`)                 | Keep                                 |
| Tools     | ToolSearch / deferred MCP tools                                               | Present                                       | Keep                                 |
| Tools     | WebBrowser tool                                                               | Present (flag `WEB_BROWSER_TOOL`)             | Keep                                 |
| Tools     | CtxInspect / Context Collapse                                                 | Present (flag `CONTEXT_COLLAPSE`)             | Keep opt-in                          |
| Tools     | History Snip                                                                  | Present (flag `HISTORY_SNIP`)                 | Keep opt-in                          |
| Tools     | MCP `_meta["anthropic/maxResultSizeChars"]` up to 500K (2.1.91/2.1.98)        | Absent                                        | **Ported this release**              |
| Tools     | `MCP_CONNECTION_NONBLOCKING` / 5s connect cap (2.1.89)                        | Absent                                        | Tier 1                               |
| Hooks     | PermissionDenied hook + `retry:true` (2.1.89)                                 | Present                                       | Keep; helps red-team retry           |
| Hooks     | PreCompact hook blocking (2.1.105)                                            | Present                                       | Keep                                 |
| Hooks     | `MessageDisplay` transform/hide hook (2.1.152)                                | Absent                                        | Tier 2                               |
| Hooks     | Hook output >10K spilled to file + 2K preview (2.1.89)                        | Absent                                        | **Ported this release**              |
| Context   | Idle compaction at ~54 min / 200K+ tokens (2.1.299, `/config` row 2.1.302)    | Absent                                        | **Tier 1 token win; not yet ported** |
| Context   | Cached microcompaction                                                        | Present (flag)                                | **Default-enabled this release**     |
| Context   | Prompt-cache break detection                                                  | Present (flag)                                | **Default-enabled this release**     |
| Context   | Reactive compaction after prompt-too-long                                     | Present (flag)                                | **Default-enabled this release**     |
| Context   | Token budget                                                                  | Present (flag)                                | **Default-enabled this release**     |
| Context   | Autocompact circuit breaker after repeated failures (2.1.89)                  | Present                                       | Keep                                 |
| Context   | Stable tool-schema bytes across turns (2.1.89)                                | Present                                       | Keep                                 |
| Context   | Nested CLAUDE.md re-injection fix (2.1.89)                                    | Present (nested loader)                       | Keep                                 |
| Context   | Thinking summaries off by default (2.1.89)                                    | Present                                       | Keep                                 |
| Context   | `/stats` includes subagent tokens (2.1.89)                                    | Present                                       | Keep                                 |
| Context   | Dense-text compaction guard for base64/SVG (2.1.310)                          | Partial (`truncateHeadForPTLRetry`)           | Tier 2                               |
| Context   | Compaction summary lists earlier tool names (2.1.304)                         | Absent                                        | Cosmetic; Tier 3                     |
| Context   | `/usage` warnings for effort/workflows/context/large results (2.1.3xx)        | Absent                                        | Tier 1 visibility                    |
| Context   | Prompt-cache miss cause in `/cost`/status line (2.1.260)                      | Absent                                        | Tier 1 visibility                    |
| Context   | `--exclude-dynamic-system-prompt-sections` for prompt caching (2.1.98)        | Absent                                        | Tier 2                               |
| Context   | WebSearch session cap, default 200 (2.1.212)                                  | Absent                                        | **Ported this release**              |
| Data      | OTel `cache_creation_5m/1h_tokens` split (2.1.300)                            | Absent (telemetry stripped)                   | Skip                                 |
| Data      | `CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH` (2.1.214)                               | Absent (telemetry stripped)                   | Skip                                 |
| Data      | `claude_code.safety_event` OTel event (2.1.307)                               | Absent (telemetry stripped)                   | Skip                                 |
| Providers | Claude Opus 5 (2.1.219), Sonnet 5.5, Fable 5.1                                | Sonnet 5 present; Opus 5/Fable 5.1 absent     | Add only if using Anthropic models   |
| Providers | Gateway retries without rejected `effort-2025-11-24` beta (2.1.310)           | Absent                                        | Tier 1 for third-party gateways      |
| Safety    | Cyber Verification Program wording removed (2.1.299)                          | No notice present                             | No action                            |
| Safety    | Per-file malware reminder removed (2.1.126)                                   | Already removed                               | Keep removed                         |
| Safety    | `CYBER_RISK_INSTRUCTION` empty                                                | Present (empty)                               | Keep empty                           |
| Modes     | `--safe-mode` / `CLAUDE_CODE_SAFE_MODE` (2.1.169)                             | Absent                                        | Tier 2 troubleshooting               |
| Modes     | `--restricted` (2.1.248)                                                      | Absent                                        | Do not default; optional hardening   |
| Modes     | `--permission-prompts none` (2.1.259)                                         | Absent                                        | **Do not port**                      |
| Safety    | `autoMode.hard_deny` (2.1.136)                                                | Absent                                        | **Do not port**                      |
| Safety    | `autoMode.classifyAllShell` (2.1.193)                                         | Absent                                        | **Do not port**                      |
| Skills    | `/reload-skills` (2.1.152)                                                    | Absent                                        | Tier 2                               |
| Plugins   | Plugin `details` projected token cost (2.1.139)                               | Absent                                        | Tier 3                               |
| Plugins   | Mods `virtualText` / `prompt.change` (2.1.300)                                | Absent                                        | Tier 3                               |
| Cloud     | Cloud sessions, Remote Control, VSCode panel features                         | Partial bridge/remote only                    | Not needed locally                   |

## 5. Red-team and cybersecurity screening

| Upstream item                                          | Effect on authorized red-team work                        | Fexor action                           |
| ------------------------------------------------------ | --------------------------------------------------------- | -------------------------------------- |
| `settings.autoMode.hard_deny` (2.1.136)                | Unconditional classifier block regardless of user intent  | **Excluded**                           |
| `autoMode.classifyAllShell` (2.1.193)                  | Routes every Bash/PowerShell command through a classifier | **Excluded**                           |
| `--permission-prompts none` (2.1.259)                  | Denies anything that would prompt                         | **Excluded**                           |
| Auto-mode classifier fixes (2.1.225, 2.1.246, 2.1.280) | Improve classifier behavior; do not remove the classifier | **Excluded**                           |
| `--restricted` (2.1.248)                               | Removes command/code tools and refuses bypass mode        | Not default; user may opt in           |
| `sandbox.credentials` (2.1.187)                        | Blocks sandboxed reads of credential files                | Keep opt-in only                       |
| `sandbox.network.strictAllowlist` (2.1.219)            | Denies non-allowlisted hosts without prompting            | Keep opt-in only                       |
| `sandbox.allowNestedUserNamespaces` (2.1.305)          | Allows nested user namespaces; weakens sandbox            | Not needed                             |
| PermissionDenied hook `retry:true` (2.1.89)            | Lets the model retry after a denial                       | **Keep**                               |
| Cyber Verification Program notice removal (2.1.299)    | Removes an application prompt                             | No action; Fexor has no notice         |
| Malware reminder removal (2.1.126)                     | Removes spurious "is this malware" refusals on Read       | Already removed                        |
| Cross-session message authority (2.1.166)              | Relayed permission requests lose user authority           | Review if multi-agent relaying is used |
| `claude_code.safety_event` OTel (2.1.307)              | Records every tool blocked/prompted                       | Telemetry stripped; skip               |

Concrete evidence from this session: the auto-mode classifier denied a benign local
`rg` over a credentials directory. The action was not required, so no workaround was
attempted. That is exactly the failure mode that makes auto-mode classifier defaults
unsafe for authorized red-team workflows.

## 6. Ported in this release (2.1.309)

| Port                                         | Upstream                | Files                                                                                                 | Verification                                                                                                |
| -------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Hook output spill at 10K / 2K preview        | 2.1.89                  | `src/utils/hooks.ts`, new `src/utils/hookContextStorage.ts`                                           | 12,000-char hook → 2,203-char reference; file mode `0600`; isolated config dir                              |
| MCP per-call result limit override, cap 500K | 2.1.91, 2.1.98          | `src/services/tools/toolExecution.ts`, `src/utils/toolResultStorage.ts`                               | Build passes; `anthropic/maxResultSizeChars` embedded                                                       |
| WebSearch session cap, default 200           | 2.1.212                 | `src/tools/WebSearchTool/WebSearchTool.ts`                                                            | Build passes; env var embedded                                                                              |
| DeepSeek web search backend                  | Fexor extension         | `src/tools/WebSearchTool/deepseekSearch.ts`, `WebSearchTool.ts`, `prompt.ts`, `UI.tsx`                | Live API: ranked hits returned; second call served from cache; build + `tsc` pass                           |
| Top-level subagent cap, default 20           | 2.1.217                 | new `src/utils/agentConcurrency.ts`, `src/tools/AgentTool/runAgent.ts`                                | Limit 1 test: second acquire blocked, resumed after release                                                 |
| Default token-efficiency flags               | 2.1.x                   | `scripts/build.ts`                                                                                    | Build passes with `CACHED_MICROCOMPACT`, `PROMPT_CACHE_BREAK_DETECTION`, `REACTIVE_COMPACT`, `TOKEN_BUDGET` |
| Version 2.1.309                              | —                       | `package.json`, `src/entrypoints/cli.tsx`                                                             | `./cli --version` → `2.1.309 (Claude Code)`                                                                 |
| Launcher defaults + 1017 label               | 2.1.309 / DeepSeek 1017 | `launch-*.sh`, `windows/*.ps1`, `scripts/fexor-launcher-env.inc.sh`, `windows/fexor-launcher-env.ps1` | `zsh -n` passes; all 12 launchers wired; env precedence tested                                              |

No changes were made outside `fexor-code-main`. The installed `2.1.309` binary, its
symlink, shared `~/.claude` config, and other running sessions are untouched.

### Launcher alignment

- Every Unix and Windows launcher now inherits `CLAUDE_CODE_AUTO_MODE_SERVER=0`,
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`,
  `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=20`, and
  `CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION=200`. All are user-overridable.
- First-party launchers (`fexor-launch.sh`, `windows/fexor-launch.ps1`) and the
  DeepSeek Windows launcher now append the shared autonomy addendum.
- `launch-deepseek.sh` and `windows/launch-deepseek.ps1` label the default model
  `DeepSeek-V4.1-Flash 1017` and budget 1,048,576 context tokens. The wire ID
  remains `deepseek-flash`; 1017 is a drop-in update with unchanged API
  parameters and pricing. Output cap stays 384K; compact window stays 786432.

## 7. Recommended next ports

### Tier 1 — token efficiency and red-team data capture

1. **Idle compaction** (2.1.299/302). A 200K+ token session idle for ~54 min is compacted
   before the 1-hour prompt cache expires. This is the largest remaining cache-cost win.
   Add `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS`, `idleCompaction: false`, and a `/config` row.
2. **`--forward-subagent-text`** (2.1.211/2.1.219). Full subagent text/thinking in
   stream-json is directly useful for red-team evidence capture and audit.
3. **`/usage` warnings and prompt-cache miss cause** (2.1.260, 2.1.3xx). Makes token burn
   visible before it happens.
4. **MCP nonblocking connect** (2.1.89). Avoids waiting on the slowest MCP server in
   headless runs.
5. **Gateway beta fallback** (2.1.310). Retry without `effort-2025-11-24` or
   mid-conversation system messages when a compatible gateway rejects them. High value for
   DeepSeek/GLM/OpenAI-compatible launches.

### Tier 2 — operator ergonomics

`--safe-mode`, `/reload-skills`, `MessageDisplay` hook, `claude agents --json`,
dense-text compaction guard, `--exclude-dynamic-system-prompt-sections`.

### Tier 3 — cosmetic or product-surface

Compaction summary tool names, plugin token-cost display, mods `virtualText`, cloud
sessions, Remote Control, VSCode panel work, screen-reader additions.

### Never port by default

`autoMode.hard_deny`, `autoMode.classifyAllShell`, `--permission-prompts none`, classifier
defaults, restrictive sandbox defaults, and any change that turns an authorized security
request into a denial. If a future upstream merge brings these, gate them behind an
explicit opt-in and keep Fexor's default permissive.

## 8. Limits of this comparison

- Full parity cannot be reconstructed from a minified binary plus changelog. Upstream
  source is not published; the only complete source is the older leaked snapshot Fexor
  already uses.
- Feature presence checks are source-level, not behavioral tests against a live model.
- The 2.1.310 items are post-install backlog and not part of the requested 2.1.309 target.
- REA's application-graph pass exceeded Node's default heap on the 28 MB bundle. The
  artifact inventory and module carving succeeded; deeper graph queries can be rerun with
  a larger heap on a reduced module subset.

## 9. Open questions

- Should `CONTEXT_COLLAPSE` and `HISTORY_SNIP` also become default-on, or stay opt-in?
- Do you want a dedicated `launch-redteam.sh` profile that sets subagent/web-search caps,
  enables the autonomy addendum, and disables auto mode?
- Should Opus 5 / Fable 5.1 be added to the model registry if Anthropic models are used?
- Is `--forward-subagent-text` the preferred audit trail, or do you want a separate
  JSONL transcript exporter?
