#!/bin/zsh
# Isolate configuration so it doesn't conflict with your regular Claude account
export CLAUDE_CONFIG_DIR="$HOME/.fexor-code-gpt"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Enable OpenAI mode
export CLAUDE_CODE_USE_OPENAI=1

# GPT/Codex auth is OAuth-based. Do not load the shared .env file here because
# this repo's .env may contain Anthropic-compatible API settings for other
# providers, which can interfere with OpenAI mode.
unset ANTHROPIC_API_KEY
unset ANTHROPIC_AUTH_TOKEN
unset ANTHROPIC_BASE_URL
unset ANTHROPIC_CUSTOM_HEADERS
unset CLAUDE_CODE_USE_BEDROCK
unset CLAUDE_CODE_USE_VERTEX
unset CLAUDE_CODE_USE_FOUNDRY

# Optional GPT-only overrides, for model names or non-secret launch settings.
if [ -f "$SCRIPT_DIR/.env.gpt" ]; then
  set -a
  source "$SCRIPT_DIR/.env.gpt"
  set +a
fi

# Default to GPT-5.5 — the flagship: xhigh-capable and far stronger at long context
# (~74% vs gpt-5.4's ~37% at 512K–1M). Switch with GPT_MODEL=gpt-5.4 (in .env.gpt or
# the env) or --model. Known Codex ids pass through verbatim; opus/sonnet map to it.
GPT_MODEL="${GPT_MODEL:-gpt-5.5}"
export ANTHROPIC_MODEL="${ANTHROPIC_MODEL:-$GPT_MODEL}"
export ANTHROPIC_DEFAULT_OPUS_MODEL="${ANTHROPIC_DEFAULT_OPUS_MODEL:-$GPT_MODEL}"
export ANTHROPIC_DEFAULT_SONNET_MODEL="${ANTHROPIC_DEFAULT_SONNET_MODEL:-$GPT_MODEL}"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="${ANTHROPIC_DEFAULT_HAIKU_MODEL:-gpt-5.4-mini}"
export ANTHROPIC_DEFAULT_OPUS_MODEL_NAME="${ANTHROPIC_DEFAULT_OPUS_MODEL_NAME:-$GPT_MODEL}"
export ANTHROPIC_DEFAULT_SONNET_MODEL_NAME="${ANTHROPIC_DEFAULT_SONNET_MODEL_NAME:-$GPT_MODEL}"
# Keep subagents on the same full GPT model, not the mini that haiku maps to.
export CLAUDE_CODE_SUBAGENT_MODEL="${CLAUDE_CODE_SUBAGENT_MODEL:-$ANTHROPIC_MODEL}"

# GPT reasoning effort. 'max' maps to backend 'xhigh' on BOTH gpt-5.4 and gpt-5.5
# (mini/codex-mini clamp to 'high'). Deliberately NOT CLAUDE_CODE_EFFORT_LEVEL (a hard
# override) so /effort and the 'ultrathink' keyword still work per turn.
if [ -z "${CLAUDE_CODE_GPT_DEFAULT_EFFORT+x}" ]; then
  case "$ANTHROPIC_MODEL" in
    gpt-5.4|gpt-5.4-pro|gpt-5.5|gpt-5.5-*)
      export CLAUDE_CODE_GPT_DEFAULT_EFFORT="max"
      ;;
    *)
      export CLAUDE_CODE_GPT_DEFAULT_EFFORT="medium"
      ;;
  esac
else
  export CLAUDE_CODE_GPT_DEFAULT_EFFORT
fi

# Context-window accounting (client-side only; sets when auto-compact fires). gpt-5.4
# already gets 1.05M from the code, but gpt-5.5 has NO entry and would default to 200K
# (premature compaction). Pin gpt-5.5 to its *Codex* window of 400K so compaction stays
# within what the Codex backend accepts. Honored after the un-gate patch.
if [ -z "${CLAUDE_CODE_MAX_CONTEXT_TOKENS+x}" ]; then
  case "$ANTHROPIC_MODEL" in
    gpt-5.5|gpt-5.5-*)
      export CLAUDE_CODE_MAX_CONTEXT_TOKENS=400000
      ;;
  esac
fi

# Answer detail: 'low' truncates explanations; 'medium' restores native-Codex-like
# length without the over-verbosity of 'high'.
export CLAUDE_CODE_GPT_VERBOSITY="${CLAUDE_CODE_GPT_VERBOSITY:-medium}"
# (MAX_THINKING_TOKENS intentionally removed: GPT runs through the Codex Responses
#  adapter, which never sees the Anthropic thinking budget. Reasoning depth = effort.)

if [ "${FEXOR_GPT_SHOW_CONFIG:-0}" = "1" ]; then
  {
    print -r -- "GPT launcher config:"
    print -r -- "  ANTHROPIC_MODEL=$ANTHROPIC_MODEL"
    print -r -- "  CLAUDE_CODE_SUBAGENT_MODEL=$CLAUDE_CODE_SUBAGENT_MODEL"
    print -r -- "  CLAUDE_CODE_GPT_DEFAULT_EFFORT=$CLAUDE_CODE_GPT_DEFAULT_EFFORT"
    print -r -- "  CLAUDE_CODE_GPT_VERBOSITY=$CLAUDE_CODE_GPT_VERBOSITY"
    print -r -- "  CLAUDE_CODE_MAX_CONTEXT_TOKENS=${CLAUDE_CODE_MAX_CONTEXT_TOKENS:-<model default>}"
  } >&2
fi

# ── Voice (/voice) ───────────────────────────────────────────────────────────
# Not available on this provider. Speech-to-text uses Anthropic's claude.ai
# voice_stream endpoint (OAuth-gated), and this launcher authenticates with
# OpenAI/Codex OAuth — so /voice is hidden. Recording (SoX) works, but
# transcription is claude.ai-only — use the Claude launchers for voice.

# Run the built binary
exec "$SCRIPT_DIR/cli-dev" "$@"
