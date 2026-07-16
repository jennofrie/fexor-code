#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/output/runpod/qwen36-abliterated.env" ]]; then
  source "$SCRIPT_DIR/output/runpod/qwen36-abliterated.env"
fi

export QWEN36_LOCAL_OUTPUT_DIR="${QWEN36_LOCAL_OUTPUT_DIR:-$SCRIPT_DIR/output/qwen36-abliterated-runpod}"
mkdir -p "$QWEN36_LOCAL_OUTPUT_DIR"

if [[ -z "${RUNPOD_POD_ID:-}" && -z "${QWEN36_FEXOR_BASE_URL:-}" ]]; then
  for url_file in "$QWEN36_LOCAL_OUTPUT_DIR/qwen36-public-url" "$SCRIPT_DIR/output/runpod/qwen36-public-url" "$SCRIPT_DIR/.qwen36-public-url"; do
    if [[ -s "$url_file" ]]; then
      public_url="$(tr -d '[:space:]' < "$url_file")"
      case "$public_url" in
        http://*|https://*)
          export QWEN36_FEXOR_BASE_URL="$public_url"
          break
          ;;
      esac
    fi
  done
fi

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
  while (($#)); do
    case "$1" in
      --model=*)
        model="${1#--model=}"
        ;;
      --model)
        if [[ $# -gt 1 ]]; then
          model="$2"
          shift
        fi
        ;;
    esac
    shift
  done
  echo "$model"
}

MODEL_DEFAULT="${QWEN36_SERVED_MODEL_NAME:-qwen36-abliterated-q4km}"
SELECTED_MODEL="$(selected_model "$MODEL_DEFAULT" "$@")"
MODEL_DESCRIPTION="${QWEN36_MODEL_DESCRIPTION:-Local RunPod llama.cpp Qwen abliterated Q4_K_M GGUF - ${QWEN36_MAX_MODEL_LEN:-262144} token context}"

export CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$QWEN36_LOCAL_OUTPUT_DIR/claude-config}"

unset CLAUDE_CODE_USE_OPENAI
unset CLAUDE_CODE_USE_BEDROCK
unset CLAUDE_CODE_USE_VERTEX
unset CLAUDE_CODE_USE_FOUNDRY
unset CLAUDE_CODE_USE_SAKANA
unset ANTHROPIC_CUSTOM_HEADERS
unset CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR
unset CLAUDE_CODE_OAUTH_TOKEN
unset CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR
unset CLAUDE_CODE_OAUTH_REFRESH_TOKEN

export ANTHROPIC_BASE_URL="${QWEN36_FEXOR_BASE_URL:-${QWEN36_LITELLM_BASE_URL:-http://127.0.0.1:${QWEN36_LITELLM_PORT:-8000}}}"
export ANTHROPIC_AUTH_TOKEN="${QWEN36_FEXOR_API_KEY:-${LITELLM_MASTER_KEY:-sk-qwen36-local}}"
export ANTHROPIC_API_KEY="$ANTHROPIC_AUTH_TOKEN"

export ANTHROPIC_MODEL="$SELECTED_MODEL"
export ANTHROPIC_DEFAULT_OPUS_MODEL="$SELECTED_MODEL"
export ANTHROPIC_DEFAULT_SONNET_MODEL="$SELECTED_MODEL"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="$SELECTED_MODEL"
export ANTHROPIC_DEFAULT_OPUS_MODEL_NAME="Qwen Abliterated 27B"
export ANTHROPIC_DEFAULT_SONNET_MODEL_NAME="Qwen Abliterated 27B"
export ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME="Qwen Abliterated 27B"
export ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION="$MODEL_DESCRIPTION"
export ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION="$ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION"
export ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION="$ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION"
export ANTHROPIC_SMALL_FAST_MODEL="${ANTHROPIC_SMALL_FAST_MODEL:-$SELECTED_MODEL}"
export CLAUDE_CODE_SUBAGENT_MODEL="${CLAUDE_CODE_SUBAGENT_MODEL:-$SELECTED_MODEL}"

export CLAUDE_CODE_MAX_CONTEXT_TOKENS="${CLAUDE_CODE_MAX_CONTEXT_TOKENS:-${QWEN36_MAX_MODEL_LEN:-262144}}"
export CLAUDE_CODE_MAX_OUTPUT_TOKENS="${CLAUDE_CODE_MAX_OUTPUT_TOKENS:-${QWEN36_FEXOR_MAX_OUTPUT_TOKENS:-256}}"
export TASK_MAX_OUTPUT_LENGTH="${TASK_MAX_OUTPUT_LENGTH:-32768}"
export BASH_MAX_OUTPUT_LENGTH="${BASH_MAX_OUTPUT_LENGTH:-32768}"
export API_TIMEOUT_MS="${API_TIMEOUT_MS:-3000000}"

# Local llama.cpp/LiteLLM does not need Anthropic thinking blocks or beta headers.
export MAX_THINKING_TOKENS="${MAX_THINKING_TOKENS:-0}"
export CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS="${CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS:-1}"
export DISABLE_INTERLEAVED_THINKING="${DISABLE_INTERLEAVED_THINKING:-1}"
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
export CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK=1

python3 - "$CLAUDE_CONFIG_DIR" "$SELECTED_MODEL" "$MODEL_DESCRIPTION" <<'PY' 2>/dev/null || true
import json, pathlib, sys
base = pathlib.Path(sys.argv[1])
base.mkdir(parents=True, exist_ok=True)
model = sys.argv[2]
desc = sys.argv[3]
label = "Qwen Abliterated 27B"
options = [{"value": model, "label": label, "description": desc, "descriptionForModel": desc}]

cj = base / ".claude.json"
try:
    d = json.loads(cj.read_text())
except Exception:
    d = {}
d["additionalModelOptionsCache"] = options
cj.write_text(json.dumps(d, indent=2))

sj = base / "settings.json"
try:
    s = json.loads(sj.read_text())
except Exception:
    s = {}
s["model"] = model
s["availableModels"] = [model]
sj.write_text(json.dumps(s, indent=2))
PY

if [[ ! -x "$SCRIPT_DIR/cli-dev" ]]; then
  if command -v bun >/dev/null 2>&1; then
    (cd "$SCRIPT_DIR" && bun install && bun run build:dev:full)
  else
    echo "[launch-qwen36] ERROR: $SCRIPT_DIR/cli-dev is missing and bun is not installed." >&2
    echo "Run: $SCRIPT_DIR/output/runpod/build-fexor-on-runpod.sh" >&2
    exit 1
  fi
fi

args=()
if ! has_arg "--model" "$@"; then
  args+=(--model "$SELECTED_MODEL")
fi
if ! has_arg "--thinking" "$@"; then
  args+=(--thinking disabled)
fi
if ! has_arg "--setting-sources" "$@" && ! has_arg "--settings" "$@"; then
  args+=(--setting-sources "")
fi
if [[ "${QWEN36_FEXOR_BARE_DEFAULT:-1}" == "1" ]] && ! has_arg "--bare" "$@"; then
  args+=(--bare)
fi

exec "$SCRIPT_DIR/cli-dev" "${args[@]}" "$@"
