#!/bin/zsh

# Anthropic-only launcher for Claude Opus 4.8 (latest) with 1M context on cli-dev.
# Uses the logged-in claude.ai OAuth session from ~/.claude by default.
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

DEFAULT_OPUS_MODEL="claude-opus-4-8[1m]"
DEFAULT_SONNET_MODEL="claude-sonnet-4-6"
DEFAULT_OPUS_EFFORT="high"
DEFAULT_SONNET_EFFORT="max"
# Voice (/voice): works here via claude.ai OAuth + SoX (brew install sox). The
# /voice toggle lives in USER settings, which this OAuth-clean launcher does not
# load by default. Launch with FREECODE_VOICE=1 to load user settings so the
# toggle persists; then run /voice and hold Space to talk.
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

selected_model() {
  local model="$DEFAULT_OPUS_MODEL"
  local i
  for ((i = 1; i <= $#; i++)); do
    local arg="${@[$i]}"
    if [[ "$arg" == "--model="* ]]; then
      model="${arg#--model=}"
      break
    fi
    if [[ "$arg" == "--model" && $i -lt $# ]]; then
      model="${@[$((i + 1))]}"
      break
    fi
  done
  echo "$model"
}

default_effort_for_model() {
  local model="${1:l}"
  if [[ "$model" == "sonnet" || "$model" == *"sonnet-4-6"* ]]; then
    echo "$DEFAULT_SONNET_EFFORT"
    return
  fi
  echo "$DEFAULT_OPUS_EFFORT"
}

unset ANTHROPIC_MODEL
unset ANTHROPIC_DEFAULT_OPUS_MODEL
unset ANTHROPIC_DEFAULT_OPUS_MODEL_NAME
unset ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION
unset ANTHROPIC_DEFAULT_HAIKU_MODEL
unset ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME
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

export ANTHROPIC_BASE_URL="https://api.anthropic.com"
export ANTHROPIC_DEFAULT_SONNET_MODEL="$DEFAULT_SONNET_MODEL"
export ANTHROPIC_DEFAULT_SONNET_MODEL_NAME="Claude Sonnet 4.6"
export ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION="Claude Sonnet 4.6 with max effort"
export ANTHROPIC_CUSTOM_MODEL_OPTION="$DEFAULT_OPUS_MODEL"
export ANTHROPIC_CUSTOM_MODEL_OPTION_NAME="Claude Opus 4.8 (1M context)"
export ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION="Claude Opus 4.8 with 1M context and high effort"
export CLAUDE_CODE_SUBAGENT_MODEL="${CLAUDE_CODE_SUBAGENT_MODEL:-$DEFAULT_OPUS_MODEL}"

args=()
if ! has_arg "--model" "$@"; then
  args+=(--model "$DEFAULT_OPUS_MODEL")
fi
if ! has_arg "--effort" "$@" && [[ -z "$CLAUDE_CODE_EFFORT_LEVEL" ]]; then
  args+=(--effort "$(default_effort_for_model "$(selected_model "$@")")")
fi
if ! has_arg "--setting-sources" "$@" && ! has_arg "--settings" "$@"; then
  args+=(--setting-sources "$DEFAULT_SETTING_SOURCES")
fi

exec "$SCRIPT_DIR/cli-dev" "${args[@]}" "$@"
