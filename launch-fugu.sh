#!/bin/zsh
# fexor-code Sakana Fugu launcher - OpenAI-compatible Responses endpoint.
#
# Usage:
#   ./launch-fugu.sh
#   ./launch-fugu.sh -p "review this change"
#   FUGU_MODEL=fugu-ultra ./launch-fugu.sh --model fugu-ultra
#
# Key sources, in order:
#   1. .env.fugu with SAKANA_API_KEY or FUGU_API_KEY
#   2. shell env SAKANA_API_KEY or FUGU_API_KEY
#   3. macOS Keychain service sakana_api_key or fugu_api_key

set -euo pipefail

export CLAUDE_CONFIG_DIR="$HOME/.fexor-code-fugu"
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

export CLAUDE_CODE_USE_SAKANA_FUGU=1

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

if [[ -f "$SCRIPT_DIR/.env.fugu" ]]; then
  set -a
  source "$SCRIPT_DIR/.env.fugu"
  set +a
fi

SAKANA_API_KEY_VALUE="${SAKANA_API_KEY:-${FUGU_API_KEY:-}}"
if [[ -z "$SAKANA_API_KEY_VALUE" ]]; then
  SAKANA_API_KEY_VALUE="$(security find-generic-password -s sakana_api_key -w 2>/dev/null || true)"
fi
if [[ -z "$SAKANA_API_KEY_VALUE" ]]; then
  SAKANA_API_KEY_VALUE="$(security find-generic-password -s fugu_api_key -w 2>/dev/null || true)"
fi

if [[ -z "$SAKANA_API_KEY_VALUE" ]]; then
  echo "[launch-fugu] ERROR: Sakana API key not found." >&2
  echo "  Add it to macOS Keychain with:" >&2
  echo "    security add-generic-password -a \"\$USER\" -s sakana_api_key -T /usr/bin/security -w 'YOUR_KEY' -U" >&2
  echo "  Or create gitignored .env.fugu with:" >&2
  echo "    export SAKANA_API_KEY='YOUR_KEY'" >&2
  exit 1
fi

export SAKANA_API_KEY="$SAKANA_API_KEY_VALUE"
unset SAKANA_API_KEY_VALUE
unset FUGU_API_KEY

# This fork disables the Claude/OpenAI/AWS auth chooser when it sees an
# external auth token. Use a non-secret sentinel; the Sakana fetch adapter
# replaces request auth with SAKANA_API_KEY for /v1/responses traffic.
export ANTHROPIC_AUTH_TOKEN="fugu-provider-auth-disabled"

# The adapter accepts either the API base or the full Responses endpoint.
export SAKANA_BASE_URL="${SAKANA_BASE_URL:-https://api.sakana.ai/v1}"

DEFAULT_FUGU_MODEL="${FUGU_MODEL:-fugu}"
SELECTED_FUGU_MODEL="$(selected_model "$DEFAULT_FUGU_MODEL" "$@")"

export ANTHROPIC_MODEL="$SELECTED_FUGU_MODEL"
export ANTHROPIC_DEFAULT_OPUS_MODEL="${FUGU_OPUS_MODEL:-fugu-ultra}"
export ANTHROPIC_DEFAULT_SONNET_MODEL="${FUGU_SONNET_MODEL:-fugu}"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="${FUGU_HAIKU_MODEL:-fugu}"
export ANTHROPIC_DEFAULT_OPUS_MODEL_NAME="${FUGU_OPUS_MODEL_NAME:-Fugu Ultra}"
export ANTHROPIC_DEFAULT_SONNET_MODEL_NAME="${FUGU_SONNET_MODEL_NAME:-Fugu}"
export ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME="${FUGU_HAIKU_MODEL_NAME:-Fugu}"
export ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION="Sakana Fugu Ultra via Responses API - 1M context"
export ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION="Sakana Fugu via Responses API - 1M context"
export ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION="Sakana Fugu via Responses API - 1M context"
export CLAUDE_CODE_SUBAGENT_MODEL="${FUGU_SUBAGENT_MODEL:-fugu}"

# Client-side budgeting only. Sakana's API enforces the actual server limits.
export API_TIMEOUT_MS="${API_TIMEOUT_MS:-7200000}"
export CLAUDE_CODE_MAX_CONTEXT_TOKENS="${CLAUDE_CODE_MAX_CONTEXT_TOKENS:-1000000}"
export CLAUDE_CODE_AUTO_COMPACT_WINDOW="${CLAUDE_CODE_AUTO_COMPACT_WINDOW:-1000000}"
export CLAUDE_CODE_MAX_OUTPUT_TOKENS="${CLAUDE_CODE_MAX_OUTPUT_TOKENS:-${FUGU_MAX_OUTPUT_TOKENS:-32000}}"

# Fugu accepts high/xhigh/max, not low/medium. The adapter clamps unsupported
# low/medium values to high; default high is the lowest accepted setting.
export CLAUDE_CODE_SAKANA_DEFAULT_EFFORT="${CLAUDE_CODE_SAKANA_DEFAULT_EFFORT:-${FUGU_EFFORT:-high}}"
export ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES="effort,max_effort"
export ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES="effort,max_effort"
export ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES="effort,max_effort"

export CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS="${CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS:-1}"
export DISABLE_INTERLEAVED_THINKING="${DISABLE_INTERLEAVED_THINKING:-1}"
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
export CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK=1

# Lock /model to the Fugu choices in this isolated config.
python3 - "$CLAUDE_CONFIG_DIR" "$DEFAULT_FUGU_MODEL" "$ANTHROPIC_DEFAULT_OPUS_MODEL" "$SELECTED_FUGU_MODEL" <<'PY' 2>/dev/null || true
import json, pathlib, sys
base = pathlib.Path(sys.argv[1]); base.mkdir(parents=True, exist_ok=True)
default_model = sys.argv[2]
ultra_model = sys.argv[3]
selected_model = sys.argv[4]
options = [
    {
        "value": "fugu",
        "label": "Fugu",
        "description": "Sakana Fugu via Responses API - 1M context",
        "descriptionForModel": "Sakana Fugu via Responses API - 1M context",
    },
    {
        "value": "fugu-ultra",
        "label": "Fugu Ultra",
        "description": "Sakana Fugu Ultra via Responses API - 1M context",
        "descriptionForModel": "Sakana Fugu Ultra via Responses API - 1M context",
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
s["model"] = default_model
s["availableModels"] = sorted({"fugu", "fugu-ultra", ultra_model, selected_model})
sj.write_text(json.dumps(s, indent=2))
PY

# Voice (/voice) is claude.ai OAuth-only in this codebase, so external API-key
# providers like Fugu should use the Claude launchers for voice transcription.

FUGU_DEFAULT_AGENT_PROMPT_FILE="${FUGU_AGENT_PROMPT_FILE:-$SCRIPT_DIR/prompts/fugu-agent-harness-system-prompt.md}"

args=()
if ! has_arg "--model" "$@"; then
  args+=(--model "$SELECTED_FUGU_MODEL")
fi
if ! has_arg "--effort" "$@" && [[ -z "${CLAUDE_CODE_EFFORT_LEVEL:-}" ]]; then
  args+=(--effort "$CLAUDE_CODE_SAKANA_DEFAULT_EFFORT")
fi
if [[ "${FUGU_AGENT_PROMPT:-1}" != "0" && "${FUGU_DISABLE_AGENT_PROMPT:-0}" != "1" ]]; then
  if ! has_arg "--append-system-prompt" "$@" && ! has_arg "--append-system-prompt-file" "$@" && [[ -f "$FUGU_DEFAULT_AGENT_PROMPT_FILE" ]]; then
    args+=(--append-system-prompt-file "$FUGU_DEFAULT_AGENT_PROMPT_FILE")
  fi
fi
if ! has_arg "--setting-sources" "$@" && ! has_arg "--settings" "$@"; then
  args+=(--setting-sources "")
fi

exec "$SCRIPT_DIR/cli-dev" "${args[@]}" "$@"
