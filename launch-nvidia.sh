#!/bin/zsh
# Fexor Code launcher for NVIDIA NIM's hosted agentic models.
#
# Profiles:
#   glm / glm-5.2         z-ai/glm-5.2
#   deepseek-pro          deepseek-ai/deepseek-v4-pro (max reasoning)
#   deepseek-flash        deepseek-ai/deepseek-v4-flash (max reasoning)
#   minimax / minimax-m3  minimaxai/minimax-m3 (adaptive reasoning)
#
# Usage:
#   ./launch-nvidia.sh
#   NVIDIA_VARIANT=deepseek-pro ./launch-nvidia.sh
#   ./launch-nvidia.sh --model deepseek-flash
#   NVIDIA_MODEL=minimaxai/minimax-m3 ./launch-nvidia.sh
#
# The credential is loaded from NVIDIA_API_KEY or macOS Keychain service
# nvidia_api_key. It is never persisted in this repository or Fexor settings.

set -euo pipefail

export CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.fexor-code-nvidia}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

NVIDIA_GLM_MODEL="z-ai/glm-5.2"
NVIDIA_DEEPSEEK_PRO_MODEL="deepseek-ai/deepseek-v4-pro"
NVIDIA_DEEPSEEK_FLASH_MODEL="deepseek-ai/deepseek-v4-flash"
NVIDIA_MINIMAX_MODEL="minimaxai/minimax-m3"

# Isolate this provider from other launcher and repo-local defaults.
unset CLAUDE_CODE_USE_OPENAI
unset CLAUDE_CODE_USE_BEDROCK
unset CLAUDE_CODE_USE_VERTEX
unset CLAUDE_CODE_USE_FOUNDRY
unset CLAUDE_CODE_USE_SAKANA_FUGU
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

export CLAUDE_CODE_USE_NVIDIA=1

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

normalize_nvidia_model() {
  local model="${1:l}"
  case "$model" in
    glm|glm-5.2|z-ai/glm-5.2)
      echo "$NVIDIA_GLM_MODEL"
      ;;
    pro|v4-pro|deepseek-pro|deepseek-v4-pro|deepseek-ai/deepseek-v4-pro)
      echo "$NVIDIA_DEEPSEEK_PRO_MODEL"
      ;;
    flash|v4-flash|deepseek-flash|deepseek-v4-flash|deepseek-ai/deepseek-v4-flash)
      echo "$NVIDIA_DEEPSEEK_FLASH_MODEL"
      ;;
    minimax|m3|minimax-m3|minimaxai/minimax-m3)
      echo "$NVIDIA_MINIMAX_MODEL"
      ;;
    *)
      echo "$1"
      ;;
  esac
}

default_nvidia_model() {
  local variant="${NVIDIA_VARIANT:-glm}"
  if [[ -n "${NVIDIA_MODEL:-}" ]]; then
    normalize_nvidia_model "$NVIDIA_MODEL"
    return
  fi

  case "${variant:l}" in
    glm|glm-5.2)
      echo "$NVIDIA_GLM_MODEL"
      ;;
    pro|v4-pro|deepseek-pro|deepseek-v4-pro)
      echo "$NVIDIA_DEEPSEEK_PRO_MODEL"
      ;;
    flash|v4-flash|deepseek-flash|deepseek-v4-flash)
      echo "$NVIDIA_DEEPSEEK_FLASH_MODEL"
      ;;
    minimax|m3|minimax-m3)
      echo "$NVIDIA_MINIMAX_MODEL"
      ;;
    *)
      echo "[launch-nvidia] ERROR: unknown NVIDIA_VARIANT '${NVIDIA_VARIANT}'." >&2
      echo "  Use glm, deepseek-pro, deepseek-flash, or minimax-m3." >&2
      exit 1
      ;;
  esac
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
  normalize_nvidia_model "$model"
}

NVIDIA_CREDENTIAL_FILE="${NVIDIA_API_KEY_FILE:-$HOME/.config/fexor-code/nvidia_api_key}"
credential_available() {
  [[ -n "${NVIDIA_API_KEY:-}" ]] && return 0
  if [[ "$OSTYPE" == darwin* ]] && /usr/bin/security find-generic-password -s nvidia_api_key >/dev/null 2>&1; then
    return 0
  fi
  [[ -f "$NVIDIA_CREDENTIAL_FILE" && ! -L "$NVIDIA_CREDENTIAL_FILE" ]] || return 1
  local permissions
  if [[ "$OSTYPE" == darwin* ]]; then
    permissions="$(stat -f '%Lp' "$NVIDIA_CREDENTIAL_FILE" 2>/dev/null || true)"
  else
    permissions="$(stat -c '%a' "$NVIDIA_CREDENTIAL_FILE" 2>/dev/null || true)"
  fi
  [[ "$permissions" == "600" ]]
}

if ! credential_available; then
  echo "[launch-nvidia] ERROR: NVIDIA API key not found." >&2
  if [[ "$OSTYPE" == darwin* ]]; then
    echo "  Store it securely with:" >&2
    echo "    security add-generic-password -a \"\$USER\" -s nvidia_api_key -T /usr/bin/security -U -w" >&2
  else
    echo "  Store it in a private credential file:" >&2
    echo "    mkdir -p \"\$HOME/.config/fexor-code\" && chmod 700 \"\$HOME/.config/fexor-code\"" >&2
    echo "    install -m 600 /dev/stdin \"\$HOME/.config/fexor-code/nvidia_api_key\"" >&2
  fi
  exit 1
fi
# Keychain is the preferred path: the TypeScript provider reads it directly,
# keeping the credential out of the environment inherited by agent tools.
if [[ -z "${NVIDIA_API_KEY:-}" ]]; then
  unset NVIDIA_API_KEY
fi

# Disable the Anthropic auth chooser with a non-secret sentinel. The adapter
# replaces request authentication with NVIDIA_API_KEY at the provider boundary.
export ANTHROPIC_AUTH_TOKEN="nvidia-provider-auth-disabled"
export NVIDIA_BASE_URL="${NVIDIA_BASE_URL:-https://integrate.api.nvidia.com/v1}"

DEFAULT_NVIDIA_MODEL="$(default_nvidia_model)"
SELECTED_NVIDIA_MODEL="$(selected_model "$DEFAULT_NVIDIA_MODEL" "$@")"

case "$SELECTED_NVIDIA_MODEL" in
  "$NVIDIA_GLM_MODEL")
    MODEL_LABEL="GLM-5.2 on NVIDIA NIM"
    MODEL_DESCRIPTION="Z.ai GLM-5.2 via NVIDIA NIM - 1M context, 16K default / 32K max output"
    MODEL_MAX_OUTPUT_TOKENS=32768
    MODEL_DEFAULT_OUTPUT_TOKENS=16384
    MODEL_CLI_EFFORT=max
    MODEL_CAPABILITIES="thinking,effort"
    export NVIDIA_TEMPERATURE="${NVIDIA_TEMPERATURE:-1}"
    export NVIDIA_TOP_P="${NVIDIA_TOP_P:-1}"
    unset NVIDIA_REASONING_EFFORT
    unset NVIDIA_THINKING_MODE
    ;;
  "$NVIDIA_DEEPSEEK_PRO_MODEL")
    MODEL_LABEL="DeepSeek V4-Pro on NVIDIA NIM"
    MODEL_DESCRIPTION="DeepSeek V4-Pro via NVIDIA NIM - 1M context, max reasoning, 16K max output"
    MODEL_MAX_OUTPUT_TOKENS=16384
    MODEL_DEFAULT_OUTPUT_TOKENS=16384
    MODEL_CLI_EFFORT=max
    MODEL_CAPABILITIES="thinking,effort,max_effort"
    export NVIDIA_TEMPERATURE="${NVIDIA_TEMPERATURE:-1}"
    export NVIDIA_TOP_P="${NVIDIA_TOP_P:-0.95}"
    export NVIDIA_REASONING_EFFORT="${NVIDIA_REASONING_EFFORT:-max}"
    unset NVIDIA_THINKING_MODE
    ;;
  "$NVIDIA_DEEPSEEK_FLASH_MODEL")
    MODEL_LABEL="DeepSeek V4-Flash on NVIDIA NIM"
    MODEL_DESCRIPTION="DeepSeek V4-Flash via NVIDIA NIM - 1M context, max reasoning, 16K max output"
    MODEL_MAX_OUTPUT_TOKENS=16384
    MODEL_DEFAULT_OUTPUT_TOKENS=16384
    MODEL_CLI_EFFORT=max
    MODEL_CAPABILITIES="thinking,effort,max_effort"
    export NVIDIA_TEMPERATURE="${NVIDIA_TEMPERATURE:-1}"
    export NVIDIA_TOP_P="${NVIDIA_TOP_P:-0.95}"
    export NVIDIA_REASONING_EFFORT="${NVIDIA_REASONING_EFFORT:-max}"
    unset NVIDIA_THINKING_MODE
    ;;
  "$NVIDIA_MINIMAX_MODEL")
    MODEL_LABEL="MiniMax M3 on NVIDIA NIM"
    MODEL_DESCRIPTION="MiniMax M3 via NVIDIA NIM - 1M context, adaptive reasoning, 16K max output"
    MODEL_MAX_OUTPUT_TOKENS=16384
    MODEL_DEFAULT_OUTPUT_TOKENS=16384
    MODEL_CLI_EFFORT=high
    MODEL_CAPABILITIES="thinking,effort"
    export NVIDIA_TEMPERATURE="${NVIDIA_TEMPERATURE:-1}"
    export NVIDIA_TOP_P="${NVIDIA_TOP_P:-0.95}"
    export NVIDIA_THINKING_MODE="${NVIDIA_THINKING_MODE:-adaptive}"
    unset NVIDIA_REASONING_EFFORT
    ;;
  *)
    MODEL_LABEL="$SELECTED_NVIDIA_MODEL on NVIDIA NIM"
    MODEL_DESCRIPTION="Custom NVIDIA NIM model - conservative 16K output profile"
    MODEL_MAX_OUTPUT_TOKENS=16384
    MODEL_DEFAULT_OUTPUT_TOKENS=16384
    MODEL_CLI_EFFORT=high
    MODEL_CAPABILITIES="thinking,effort"
    export NVIDIA_TEMPERATURE="${NVIDIA_TEMPERATURE:-1}"
    export NVIDIA_TOP_P="${NVIDIA_TOP_P:-0.95}"
    unset NVIDIA_REASONING_EFFORT
    unset NVIDIA_THINKING_MODE
    ;;
esac

if [[ "$SELECTED_NVIDIA_MODEL" == "$NVIDIA_DEEPSEEK_PRO_MODEL" || "$SELECTED_NVIDIA_MODEL" == "$NVIDIA_DEEPSEEK_FLASH_MODEL" ]]; then
  case "$NVIDIA_REASONING_EFFORT" in
    none|high|max) ;;
    *)
      echo "[launch-nvidia] ERROR: NVIDIA_REASONING_EFFORT must be none, high, or max." >&2
      exit 1
      ;;
  esac
fi
if [[ "$SELECTED_NVIDIA_MODEL" == "$NVIDIA_MINIMAX_MODEL" ]]; then
  case "$NVIDIA_THINKING_MODE" in
    disabled|enabled|adaptive) ;;
    *)
      echo "[launch-nvidia] ERROR: NVIDIA_THINKING_MODE must be disabled, enabled, or adaptive." >&2
      exit 1
      ;;
  esac
fi

REQUESTED_OUTPUT_TOKENS="${NVIDIA_MAX_OUTPUT_TOKENS:-${CLAUDE_CODE_MAX_OUTPUT_TOKENS:-$MODEL_DEFAULT_OUTPUT_TOKENS}}"
if [[ ! "$REQUESTED_OUTPUT_TOKENS" =~ '^[1-9][0-9]*$' ]]; then
  echo "[launch-nvidia] ERROR: NVIDIA_MAX_OUTPUT_TOKENS must be a positive integer." >&2
  exit 1
fi
if (( REQUESTED_OUTPUT_TOKENS > MODEL_MAX_OUTPUT_TOKENS )); then
  echo "[launch-nvidia] WARNING: $SELECTED_NVIDIA_MODEL caps output at $MODEL_MAX_OUTPUT_TOKENS tokens; clamping $REQUESTED_OUTPUT_TOKENS." >&2
  EFFECTIVE_OUTPUT_TOKENS="$MODEL_MAX_OUTPUT_TOKENS"
else
  EFFECTIVE_OUTPUT_TOKENS="$REQUESTED_OUTPUT_TOKENS"
fi

export ANTHROPIC_MODEL="$SELECTED_NVIDIA_MODEL"
export ANTHROPIC_DEFAULT_OPUS_MODEL="$NVIDIA_DEEPSEEK_PRO_MODEL"
export ANTHROPIC_DEFAULT_SONNET_MODEL="$SELECTED_NVIDIA_MODEL"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="$NVIDIA_DEEPSEEK_FLASH_MODEL"
export ANTHROPIC_DEFAULT_OPUS_MODEL_NAME="DeepSeek V4-Pro on NVIDIA NIM"
export ANTHROPIC_DEFAULT_SONNET_MODEL_NAME="$MODEL_LABEL"
export ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME="DeepSeek V4-Flash on NVIDIA NIM"
export ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION="DeepSeek V4-Pro via NVIDIA NIM - 1M context, max reasoning, 16K max output"
export ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION="$MODEL_DESCRIPTION"
export ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION="DeepSeek V4-Flash via NVIDIA NIM - 1M context, max reasoning, 16K max output"
export CLAUDE_CODE_SUBAGENT_MODEL="$(normalize_nvidia_model "${NVIDIA_SUBAGENT_MODEL:-$SELECTED_NVIDIA_MODEL}")"

# All four hosted profiles publish a 1M input context. Output is a separate
# provider limit and is clamped above before Fexor starts.
export API_TIMEOUT_MS="${API_TIMEOUT_MS:-3000000}"
export CLAUDE_CODE_MAX_CONTEXT_TOKENS="${CLAUDE_CODE_MAX_CONTEXT_TOKENS:-1000000}"
export CLAUDE_CODE_AUTO_COMPACT_WINDOW="${CLAUDE_CODE_AUTO_COMPACT_WINDOW:-1000000}"
export CLAUDE_CODE_MAX_OUTPUT_TOKENS="$EFFECTIVE_OUTPUT_TOKENS"

export ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES="thinking,effort,max_effort"
export ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES="$MODEL_CAPABILITIES"
export ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES="thinking,effort,max_effort"
export CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1
export DISABLE_INTERLEAVED_THINKING=1
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
export CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK=1

# Keep the isolated picker stable across sessions and expose every verified tier.
python3 - "$CLAUDE_CONFIG_DIR" "$SELECTED_NVIDIA_MODEL" \
  "$NVIDIA_GLM_MODEL" "$NVIDIA_DEEPSEEK_PRO_MODEL" \
  "$NVIDIA_DEEPSEEK_FLASH_MODEL" "$NVIDIA_MINIMAX_MODEL" <<'PY' 2>/dev/null || true
import json, pathlib, sys
base = pathlib.Path(sys.argv[1]); base.mkdir(parents=True, exist_ok=True)
selected, glm, pro, flash, minimax = sys.argv[2:]
options = [
    {
        "value": glm,
        "label": "GLM-5.2 on NVIDIA NIM",
        "description": "1M context, 16K default / 32K max output",
        "descriptionForModel": "GLM-5.2 via NVIDIA NIM - 1M context, 16K default / 32K max output",
    },
    {
        "value": pro,
        "label": "DeepSeek V4-Pro on NVIDIA NIM",
        "description": "1M context, max reasoning, 16K max output",
        "descriptionForModel": "DeepSeek V4-Pro via NVIDIA NIM - 1M context, max reasoning, 16K max output",
    },
    {
        "value": flash,
        "label": "DeepSeek V4-Flash on NVIDIA NIM",
        "description": "1M context, max reasoning, 16K max output",
        "descriptionForModel": "DeepSeek V4-Flash via NVIDIA NIM - 1M context, max reasoning, 16K max output",
    },
    {
        "value": minimax,
        "label": "MiniMax M3 on NVIDIA NIM",
        "description": "1M context, adaptive reasoning, 16K max output",
        "descriptionForModel": "MiniMax M3 via NVIDIA NIM - 1M context, adaptive reasoning, 16K max output",
    },
]
for name, update in (
    (".claude.json", {"additionalModelOptionsCache": options}),
    ("settings.json", {"model": selected, "availableModels": [glm, pro, flash, minimax]}),
):
    path = base / name
    try: data = json.loads(path.read_text())
    except Exception: data = {}
    data.update(update)
    path.write_text(json.dumps(data, indent=2))
PY

# Replace model aliases in argv with the normalized NVIDIA model ID.
passthrough_args=()
skip_next=0
for arg in "$@"; do
  if (( skip_next )); then
    skip_next=0
    continue
  fi
  if [[ "$arg" == "--model" ]]; then
    skip_next=1
    continue
  fi
  if [[ "$arg" == "--model="* ]]; then
    continue
  fi
  passthrough_args+=("$arg")
done

args=(--model "$SELECTED_NVIDIA_MODEL")
if ! has_arg "--effort" "${passthrough_args[@]}" && [[ -z "${CLAUDE_CODE_EFFORT_LEVEL:-}" ]]; then
  args+=(--effort "${NVIDIA_EFFORT:-$MODEL_CLI_EFFORT}")
fi
if ! has_arg "--setting-sources" "${passthrough_args[@]}" && ! has_arg "--settings" "${passthrough_args[@]}"; then
  args+=(--setting-sources "")
fi

exec "$SCRIPT_DIR/cli-dev" "${args[@]}" "${passthrough_args[@]}"
