#!/bin/zsh

# Clean Anthropic subscription launcher. This path intentionally uses the
# logged-in claude.ai OAuth session from ~/.claude, not external API tokens.
SCRIPT_PATH="$0"
while [[ -L "$SCRIPT_PATH" ]]; do
  LINK_TARGET="$(readlink "$SCRIPT_PATH")"
  if [[ "$LINK_TARGET" == /* ]]; then
    SCRIPT_PATH="$LINK_TARGET"
  else
    SCRIPT_PATH="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)/$LINK_TARGET"
  fi
done
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"

DEFAULT_MODEL="claude-opus-4-8[1m]"
DEFAULT_EFFORT="high"
DEFAULT_THINKING="adaptive"
# Keep this launcher OAuth-clean by default. User/project settings can contain
# apiKeyHelper or provider env that override the logged-in Claude subscription.
# Voice (/voice): works here via claude.ai OAuth + SoX (brew install sox). The
# /voice toggle is stored in USER settings, which this OAuth-clean launcher does
# not load by default (--setting-sources ""). Launch with FREECODE_VOICE=1 to load
# user settings so the toggle persists; then run /voice and hold Space to talk.
DEFAULT_SETTING_SOURCES="${FREECODE_VOICE:+user}"

has_arg() {
  local needle="$1"
  shift
  for arg in "$@"; do
    if [[ "$arg" == "$needle" || "$arg" == "$needle="* ]]; then
      return 0
    fi
  done
  return 1
}

export ANTHROPIC_MODEL=
unset ANTHROPIC_DEFAULT_OPUS_MODEL
unset ANTHROPIC_DEFAULT_SONNET_MODEL
unset ANTHROPIC_DEFAULT_HAIKU_MODEL
unset ANTHROPIC_DEFAULT_OPUS_MODEL_NAME
unset ANTHROPIC_DEFAULT_SONNET_MODEL_NAME
unset CLAUDE_CODE_SUBAGENT_MODEL
unset CLAUDE_CONFIG_DIR
unset CLAUDE_CODE_USE_OPENAI
unset CLAUDE_CODE_USE_BEDROCK
unset CLAUDE_CODE_USE_VERTEX
unset CLAUDE_CODE_USE_FOUNDRY

export ANTHROPIC_API_KEY=
export ANTHROPIC_AUTH_TOKEN=
export ANTHROPIC_CUSTOM_HEADERS=
export CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR=
export CLAUDE_CODE_OAUTH_TOKEN=
export CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR=
export CLAUDE_CODE_OAUTH_REFRESH_TOKEN=

export ANTHROPIC_BASE_URL=https://api.anthropic.com
export ANTHROPIC_DEFAULT_OPUS_MODEL="claude-opus-4-8"
export ANTHROPIC_DEFAULT_OPUS_MODEL_NAME="Claude Opus 4.8"
export CLAUDE_CODE_SUBAGENT_MODEL="$DEFAULT_MODEL"

args=()
if ! has_arg "--model" "$@"; then
  args+=(--model "$DEFAULT_MODEL")
fi
if ! has_arg "--effort" "$@" && [[ -z "$CLAUDE_CODE_EFFORT_LEVEL" ]]; then
  args+=(--effort "$DEFAULT_EFFORT")
fi
if ! has_arg "--thinking" "$@"; then
  args+=(--thinking "$DEFAULT_THINKING")
fi
if ! has_arg "--setting-sources" "$@" && ! has_arg "--settings" "$@"; then
  args+=(--setting-sources "$DEFAULT_SETTING_SOURCES")
fi

exec "$SCRIPT_DIR/cli-dev" "${args[@]}" "$@"
