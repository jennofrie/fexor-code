# GLM 5.2 Fexor Code Handover

## Goal

Integrate Z.AI GLM 5.2 into `fexor-code-main` as a Claude Code compatible coding agent profile with:

- GLM 5.2 1M context mode by default.
- 32K default output budget, with opt-in 128K maximum output token support.
- Max reasoning effort by default.
- A short autonomy-oriented system prompt addendum inspired by Venice AI's public positioning, without copying unverified or proprietary system prompt text.

## Public Research Basis

Z.AI documents Claude Code usage through its Anthropic-compatible endpoint:

- `ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic`
- `ANTHROPIC_MODEL=glm-5.2[1m]`
- `CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000000`
- `/effort max` recommended for coding-oriented use.
- `ANTHROPIC_DEFAULT_HAIKU_MODEL=glm-4.5-air` in the latest model-switching guide.
- `API_TIMEOUT_MS=3000000` in the Claude Code setup guide.

Z.AI's GLM 5.2 docs and release material describe:

- 1,000,000 token context window.
- 128,000 maximum output tokens.
- Tool/function calling support.
- Long-horizon coding and agentic use cases.

Venice AI's public docs and model-card style statements indicate a permissive design pattern:

- Default system behavior is optimized for direct, uncensored, natural responses.
- User or API caller control over system prompts is a product feature.
- The practical pattern is not a long jailbreak prompt; it is a concise autonomy/default-compliance addendum paired with permissive model selection.

Do not claim a verbatim Venice system prompt is known or copied. Treat leaked prompt claims as unverified.

## Local Implementation

Launcher:

- `launch-glm.sh`

Prompt addendum:

- `prompts/glm-autonomy-system-prompt.md`

Model/runtime support:

- `src/utils/context.ts`
- `src/utils/effort.ts`

Tests:

- `src/utils/context.test.ts`
- `src/utils/effort.test.ts`

The launcher isolates GLM config under:

- `CLAUDE_CONFIG_DIR=$HOME/.fexor-code-glm`

It loads the Z.AI key from `.env.glm`, shell env, or macOS Keychain services `glm_api_key` / `zai_api_key`.

## Current Defaults

- Model: `glm-5.2[1m]`
- Base URL: `https://api.z.ai/api/anthropic`
- Context budget: `CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000`
- Auto compact window: `CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000000`
- Timeout: `API_TIMEOUT_MS=3000000`
- Output cap: `CLAUDE_CODE_MAX_OUTPUT_TOKENS=32000`
  - Use `GLM_MAX_OUTPUT_TOKENS=128000` only when a task genuinely needs a huge single response.
- Reasoning effort: `--effort max`
- Thinking budget: `MAX_THINKING_TOKENS=16000`
- Subagent model: `glm-4.5-air` by default via `CLAUDE_CODE_SUBAGENT_MODEL`
- Rate-limit handling: `CLAUDE_CODE_UNATTENDED_RETRY=1`
- Concurrent GLM sessions: blocked by default; set `GLM_ALLOW_CONCURRENT=1` only when intentionally running parallel GLM sessions.

The launcher appends `prompts/glm-autonomy-system-prompt.md` by default unless:

- `GLM_AUTONOMY_PROMPT=0`
- `GLM_DISABLE_AUTONOMY_PROMPT=1`
- `--append-system-prompt` is supplied
- `--append-system-prompt-file` is supplied

Use `GLM_AUTONOMY_PROMPT_FILE=/path/to/file.md` to inject a different prompt file.

## Important Token Clarification

`1,000,000` is the context/input window: system prompt, user prompt, conversation history, file/tool context, and tool results.

`128,000` is the maximum output for one model response. It is not the same as context.

`MAX_THINKING_TOKENS=16000` is a hidden reasoning budget. It is separate from the visible answer, but it still consumes generation capacity internally.

## Suggested QA

Run:

```sh
zsh -n launch-glm.sh
bun test src/utils/effort.test.ts src/utils/context.test.ts
bun run ./scripts/build.ts --dev --feature UNATTENDED_RETRY
```

Optional live smoke tests:

```sh
./launch-glm.sh -p 'Reply exactly GLM_QA_OK.' --max-turns 1 --output-format text --tools ''
./launch-glm.sh -p 'Use Bash to run pwd. If it ends with fexor-code-main, reply exactly GLM_TOOL_LOOP_OK.' --max-turns 3 --output-format text --permission-mode bypassPermissions
```

Official Claude Code wrapper:

```sh
./launch-claude-glm.sh
./launch-claude-glm.sh -p 'Reply exactly GLM_CLAUDE_OK.' --max-turns 1 --output-format text --tools ''
```

`launch-claude-glm.sh` reads the Z.AI key from env or macOS Keychain and starts the official `claude` binary with GLM env. It intentionally avoids writing the token into `~/.claude/settings.json`.
