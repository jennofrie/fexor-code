#!/bin/zsh
# fexor-code isolated launcher — powered by DeepSeek V4-Pro with thinking
# Runs fexor-code with its own config directory, completely separate from
# the official Claude Code CLI (~/.claude/).
#
# Usage:
#   ./launch.sh                          # interactive REPL
#   ./launch.sh -p "explain this repo"   # one-shot
#   ./launch.sh --model deepseek-v4-pro  # specify model
#
# To add a shell alias:
#   echo 'alias fexor="~/Desktop/Github/fexor-code-main/launch.sh"' >> ~/.zshrc

export CLAUDE_CONFIG_DIR="$HOME/.fexor-code"

# ── Load API key (gitignored) ─────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [[ -f "$SCRIPT_DIR/.env.deepseek" ]]; then
  source "$SCRIPT_DIR/.env.deepseek"
fi
# Hard override — ensures any stale stored key in ~/.fexor-code/ cannot win
export ANTHROPIC_AUTH_TOKEN

# ── DeepSeek V4 — Anthropic-compatible endpoint ───────────────────────────────
export ANTHROPIC_BASE_URL="https://api.deepseek.com/anthropic"

# Map every model tier to DeepSeek V4-Pro (Pro for Opus/Sonnet, Flash for Haiku)
export ANTHROPIC_MODEL="deepseek-v4-pro"
export ANTHROPIC_DEFAULT_OPUS_MODEL="deepseek-v4-pro"
export ANTHROPIC_DEFAULT_SONNET_MODEL="deepseek-v4-pro"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="deepseek-v4-flash"
export CLAUDE_CODE_SUBAGENT_MODEL="deepseek-v4-pro"

# ── Thinking ─────────────────────────────────────────────────────────────────
# NOTE: DeepSeek is classified as a 'firstParty' provider (only ANTHROPIC_BASE_URL
# is set), so ANTHROPIC_DEFAULT_*_MODEL_SUPPORTED_CAPABILITIES is INERT here — the
# capability override is skipped for firstParty. Thinking/adaptive-thinking are
# granted automatically by the firstParty heuristics for a non-Claude model id, so
# the model already sends {type:'adaptive'} (the strongest reasoning mode). We keep
# a trimmed capabilities hint for documentation; effort/max_effort/interleaved were
# dropped because they only add Anthropic-proprietary wire artifacts.
export ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES="thinking,adaptive_thinking"
export ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES="thinking,adaptive_thinking"
# Fallback budget — only reaches the wire if adaptive thinking is disabled (it is a
# no-op while adaptive is active). Set CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1 to use it.
export MAX_THINKING_TOKENS=16000

# ── Maximize the token window (DeepSeek V4-Pro = native 1M context) ──────────
# Without this, fexor-code budgets an unknown model at only 200K and auto-compacts
# ~5x too early. CLAUDE_CODE_MAX_CONTEXT_TOKENS is a client-side budgeting value
# (never sent to the API) and is honored in external builds after the un-gate patch.
export CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000
# Raise the per-turn output ceiling to fexor-code's max for an unknown model (64K).
export CLAUDE_CODE_MAX_OUTPUT_TOKENS=64000

# ── 3rd-party fidelity: strip Anthropic-only betas + experimental tool fields ─
# DeepSeek's Anthropic-compatible endpoint implements core Messages only. This
# suppresses prompt-caching-scope/context-management/redact-thinking betas AND strips
# strict/defer_loading/eager_input_streaming from tool schemas (prevents "Extra inputs
# are not permitted" 400s) — the single biggest tool-reliability fix. Base prompt
# caching (cache_control) is preserved.
export CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1
# interleaved-thinking-2025-05-14 is granted by the firstParty heuristic and is not
# stripped by the line above; DeepSeek doesn't implement it, so suppress the header.
export DISABLE_INTERLEAVED_THINKING=1

# ── Stability: disable Anthropic telemetry & non-streaming fallback ──────────
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
export CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK=1

# ── Voice (/voice) ───────────────────────────────────────────────────────────
# Not available on this provider. Speech-to-text uses Anthropic's claude.ai
# voice_stream endpoint (OAuth-gated), so /voice is hidden for API-key providers
# like DeepSeek. Recording (SoX) works, but transcription is claude.ai-only —
# use fexor-launch.sh / launch-claude-opus45.sh for voice.

exec "$SCRIPT_DIR/cli-dev" "$@"
