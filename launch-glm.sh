#!/bin/zsh
# fexor-code GLM launcher - Z.AI Anthropic Messages endpoint.
#
# Usage:
#   ./launch-glm.sh
#   ./launch-glm.sh -p "review this change"
#   GLM_MODEL=glm-5.2 ./launch-glm.sh --model glm-5.2
#   GLM_MAX_OUTPUT_TOKENS=128000 ./launch-glm.sh
#
# Key sources, in order:
#   1. .env.glm with GLM_API_KEY, ZAI_API_KEY, or Z_AI_API_KEY
#   2. shell env GLM_API_KEY, ZAI_API_KEY, or Z_AI_API_KEY
#   3. macOS Keychain service glm_api_key or zai_api_key

export CLAUDE_CONFIG_DIR="$HOME/.fexor-code-glm"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Keep this provider isolated from other launchers and repo-local .env defaults.
unset CLAUDE_CODE_USE_OPENAI
unset CLAUDE_CODE_USE_BEDROCK
unset CLAUDE_CODE_USE_VERTEX
unset CLAUDE_CODE_USE_FOUNDRY
unset ANTHROPIC_API_KEY
unset ANTHROPIC_AUTH_TOKEN
unset ANTHROPIC_BASE_URL
unset ANTHROPIC_CUSTOM_HEADERS
unset CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR
unset CLAUDE_CODE_OAUTH_TOKEN
unset CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR
unset CLAUDE_CODE_OAUTH_REFRESH_TOKEN
unset ANTHROPIC_MODEL
unset ANTHROPIC_DEFAULT_OPUS_MODEL
unset ANTHROPIC_DEFAULT_SONNET_MODEL
unset ANTHROPIC_DEFAULT_HAIKU_MODEL

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
  local model="$1"
  shift
  local i=1
  while (( i <= $# )); do
    local arg="${@[$i]}"
    if [[ "$arg" == "--model="* ]]; then
      model="${arg#--model=}"
    elif [[ "$arg" == "--model" && $i -lt $# ]]; then
      model="${@[$((i + 1))]}"
    fi
    (( i++ ))
  done
  echo "$model"
}

existing_glm_sessions() {
  ps -axo pid=,command= | awk '
    /\/fexor-code-main\/cli-dev/ && /--model(=| )glm-/ {
      sub(/^[[:space:]]+/, "", $0)
      print
    }
  '
}

if [[ "${GLM_ALLOW_CONCURRENT:-0}" != "1" ]]; then
  existing_sessions="$(existing_glm_sessions)"
  if [[ -n "$existing_sessions" ]]; then
    echo "[launch-glm] ERROR: another GLM fexor-code session is already running." >&2
    echo "  Stop that session first, or relaunch with GLM_ALLOW_CONCURRENT=1 if you intentionally want parallel GLM sessions." >&2
    echo "$existing_sessions" >&2
    exit 1
  fi
  unset existing_sessions
fi

if [[ -f "$SCRIPT_DIR/.env.glm" ]]; then
  set -a
  source "$SCRIPT_DIR/.env.glm"
  set +a
fi

GLM_API_KEY_VALUE="${GLM_API_KEY:-${ZAI_API_KEY:-${Z_AI_API_KEY:-}}}"
if [[ -z "$GLM_API_KEY_VALUE" ]]; then
  GLM_API_KEY_VALUE="$(security find-generic-password -s glm_api_key -w 2>/dev/null)"
fi
if [[ -z "$GLM_API_KEY_VALUE" ]]; then
  GLM_API_KEY_VALUE="$(security find-generic-password -s zai_api_key -w 2>/dev/null)"
fi

if [[ -z "$GLM_API_KEY_VALUE" ]]; then
  echo "[launch-glm] ERROR: GLM/Z.AI API key not found." >&2
  echo "  Add it to macOS Keychain with:" >&2
  echo "    security add-generic-password -a \"\$USER\" -s glm_api_key -T /usr/bin/security -w 'YOUR_KEY' -U" >&2
  echo "  Or create gitignored .env.glm with:" >&2
  echo "    export GLM_API_KEY='YOUR_KEY'" >&2
  exit 1
fi

# The Anthropic SDK path can use apiKey; Z.AI's Claude-compatible endpoint uses
# Bearer auth. Set both so direct SDK calls and gateway header injection agree.
export ANTHROPIC_API_KEY="$GLM_API_KEY_VALUE"
export ANTHROPIC_AUTH_TOKEN="$GLM_API_KEY_VALUE"
unset GLM_API_KEY_VALUE
unset GLM_API_KEY
unset ZAI_API_KEY
unset Z_AI_API_KEY

export ANTHROPIC_BASE_URL="${GLM_BASE_URL:-${ANTHROPIC_BASE_URL:-https://api.z.ai/api/anthropic}}"

# Z.AI documents GLM 5.2 1M mode for Claude Code with the [1m] suffix.
DEFAULT_GLM_MODEL="${GLM_MODEL:-glm-5.2[1m]}"
SELECTED_GLM_MODEL="$(selected_model "$DEFAULT_GLM_MODEL" "$@")"
GLM_LABEL="GLM-5.2"
GLM_DESC="Z.AI GLM-5.2 via Anthropic API - 1M context, max effort"

export ANTHROPIC_MODEL="$SELECTED_GLM_MODEL"
export ANTHROPIC_DEFAULT_OPUS_MODEL="$DEFAULT_GLM_MODEL"
export ANTHROPIC_DEFAULT_SONNET_MODEL="$DEFAULT_GLM_MODEL"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="${GLM_HAIKU_MODEL:-glm-4.5-air}"
export ANTHROPIC_DEFAULT_OPUS_MODEL_NAME="$GLM_LABEL (1M context)"
export ANTHROPIC_DEFAULT_SONNET_MODEL_NAME="$GLM_LABEL (1M context)"
export ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME="$ANTHROPIC_DEFAULT_HAIKU_MODEL"
export ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION="$GLM_DESC"
export ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION="$GLM_DESC"
export ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION="Z.AI $ANTHROPIC_DEFAULT_HAIKU_MODEL via Anthropic API"
export CLAUDE_CODE_SUBAGENT_MODEL="${GLM_SUBAGENT_MODEL:-$ANTHROPIC_DEFAULT_HAIKU_MODEL}"

# Client-side budgeting and Z.AI's documented compression window. These are not
# API tokens; they decide when fexor-code warns and auto-compacts locally.
export API_TIMEOUT_MS="${API_TIMEOUT_MS:-3000000}"
export CLAUDE_CODE_MAX_CONTEXT_TOKENS="${CLAUDE_CODE_MAX_CONTEXT_TOKENS:-1000000}"
export CLAUDE_CODE_AUTO_COMPACT_WINDOW="${CLAUDE_CODE_AUTO_COMPACT_WINDOW:-1000000}"
# GLM-5.2 can support 128K output, but reserving that much on every request can
# increase capacity pressure. Opt in with GLM_MAX_OUTPUT_TOKENS=128000 when needed.
export CLAUDE_CODE_MAX_OUTPUT_TOKENS="${CLAUDE_CODE_MAX_OUTPUT_TOKENS:-${GLM_MAX_OUTPUT_TOKENS:-32000}}"

# GLM-5.2 advertises high/max reasoning effort. The source allowlist preserves
# max instead of clamping it to high.
export ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES="thinking,effort,max_effort"
export ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES="thinking,effort,max_effort"
export ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES="thinking,effort"
export MAX_THINKING_TOKENS="${MAX_THINKING_TOKENS:-16000}"

# Z.AI's Anthropic endpoint is for coding-tool Messages traffic. Keep the same
# proxy hardening used by the other third-party launchers.
export CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS="${CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS:-1}"
export DISABLE_INTERLEAVED_THINKING="${DISABLE_INTERLEAVED_THINKING:-1}"
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
export CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK=1

# Z.AI often returns strict request-window 429s with retry-after in the body.
# For agent harness sessions, keep waiting through those cooldowns instead of
# exhausting the normal retry count and surfacing a final API error.
export CLAUDE_CODE_UNATTENDED_RETRY="${CLAUDE_CODE_UNATTENDED_RETRY:-1}"

# Lock /model to the GLM choices in this isolated config.
python3 - "$CLAUDE_CONFIG_DIR" "$DEFAULT_GLM_MODEL" "$ANTHROPIC_DEFAULT_HAIKU_MODEL" <<'PY' 2>/dev/null || true
import json, pathlib, sys
base = pathlib.Path(sys.argv[1]); base.mkdir(parents=True, exist_ok=True)
glm = sys.argv[2]
haiku = sys.argv[3]
options = [
    {
        "value": glm,
        "label": "GLM-5.2 (1M context)",
        "description": "Z.AI GLM-5.2 via Anthropic API - 1M context, max effort",
        "descriptionForModel": "Z.AI GLM-5.2 via Anthropic API - 1M context, max effort",
    },
    {
        "value": haiku,
        "label": haiku,
        "description": f"Z.AI {haiku} via Anthropic API",
        "descriptionForModel": f"Z.AI {haiku} via Anthropic API",
    },
]

cj = base / ".claude.json"
try: d = json.loads(cj.read_text())
except Exception: d = {}
d["additionalModelOptionsCache"] = options
cj.write_text(json.dumps(d, indent=2))

sj = base / "settings.json"
try: s = json.loads(sj.read_text())
except Exception: s = {}
s["model"] = glm
s["availableModels"] = [glm, haiku]
sj.write_text(json.dumps(s, indent=2))
PY

# Voice (/voice) is claude.ai OAuth-only in this codebase, so external API-key
# providers like GLM should use the Claude launchers for voice transcription.

GLM_DEFAULT_AUTONOMY_PROMPT_FILE="${GLM_AUTONOMY_PROMPT_FILE:-$SCRIPT_DIR/prompts/glm-autonomy-system-prompt.md}"

args=()
if ! has_arg "--model" "$@"; then
  args+=(--model "$SELECTED_GLM_MODEL")
fi
if ! has_arg "--effort" "$@" && [[ -z "$CLAUDE_CODE_EFFORT_LEVEL" ]]; then
  args+=(--effort "${GLM_EFFORT:-max}")
fi
if ! has_arg "--thinking" "$@" && [[ -n "$GLM_THINKING" ]]; then
  args+=(--thinking "$GLM_THINKING")
fi
if [[ "${GLM_AUTONOMY_PROMPT:-1}" != "0" && "${GLM_DISABLE_AUTONOMY_PROMPT:-0}" != "1" ]]; then
  if ! has_arg "--append-system-prompt" "$@" && ! has_arg "--append-system-prompt-file" "$@" && [[ -f "$GLM_DEFAULT_AUTONOMY_PROMPT_FILE" ]]; then
    args+=(--append-system-prompt-file "$GLM_DEFAULT_AUTONOMY_PROMPT_FILE")
  fi
fi
if ! has_arg "--setting-sources" "$@" && ! has_arg "--settings" "$@"; then
  args+=(--setting-sources "")
fi

exec "$SCRIPT_DIR/cli-dev" "${args[@]}" "$@"
