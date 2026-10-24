#!/bin/zsh
# fexor-code isolated launcher — DeepSeek-V4.1-Flash 1017 / V4 Pro, effort max
# https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code
#
# Live API IDs (verified 2026-10-24): deepseek-flash, deepseek-v4-pro.
# 1017 (2026-10-17) is a drop-in update behind the same deepseek-flash ID:
# API parameters and pricing are unchanged; context is 1,048,576 tokens.
# Retired names (deepseek-v4-flash, deepseek-v4-flash-vision-exp) are not used.
# There is no published deepseek-v4.1-pro ID; Pro is deepseek-v4-pro.
#
# Default (official Claude Code mapping):
#   main/opus/sonnet = deepseek-flash[1m]
#   haiku/subagents  = deepseek-flash
#   effort           = max
#   context budget   = 1048576
#   compact window   = 786432
#
# Isolated from official Claude Code (~/.claude) and ~/Desktop/claude.
#
# Usage:
#   ./launch-deepseek.sh                          # V4.1-Flash 1017 1M, effort max
#   ./launch-deepseek.sh --model deepseek-v4-pro  # V4 Pro 1M, effort max
#   ./launch-deepseek.sh -p "explain this repo"
#   DEEPSEEK_VARIANT=pro ./launch-deepseek.sh
#   DEEPSEEK_MAX_OUTPUT_TOKENS=384000 ./launch-deepseek.sh
#
# To add a shell alias:
#   echo 'alias fexor-deepseek="~/Desktop/Github/fexor-code-main/launch-deepseek.sh"' >> ~/.zshrc

export CLAUDE_CONFIG_DIR="$HOME/.fexor-code"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

DEEPSEEK_FLASH_MAIN="deepseek-flash[1m]"
DEEPSEEK_FLASH_BARE="deepseek-flash"
DEEPSEEK_FLASH_NAME="DeepSeek-V4.1-Flash 1017"
DEEPSEEK_PRO_MAIN="deepseek-v4-pro[1m]"
DEEPSEEK_PRO_BARE="deepseek-v4-pro"
DEEPSEEK_PRO_NAME="DeepSeek V4 Pro"

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

# flash | pro. Wire IDs only: deepseek-flash and deepseek-v4-pro.
selected_family() {
  local raw="${DEEPSEEK_MODEL:-${DEEPSEEK_VARIANT:-flash}}"
  local i=1
  while (( i <= $# )); do
    local arg="${@[$i]}"
    if [[ "$arg" == "--model="* ]]; then
      raw="${arg#--model=}"
    elif [[ "$arg" == "--model" && $i -lt $# ]]; then
      raw="${@[$((i + 1))]}"
    fi
    (( i++ ))
  done
  case "${raw:l}" in
    pro|deepseek-pro|deepseek-v4-pro|deepseek-v4-pro\[1m\]|v4-pro|v4.1-pro|v41-pro|deepseek-v4.1-pro|deepseek-v41-pro)
      echo pro
      ;;
    *)
      echo flash
      ;;
  esac
}

normalize_deepseek_thinking() {
  local thinking="${1:l}"
  case "$thinking" in
    disabled|off|none) echo "disabled" ;;
    *) echo "enabled" ;;
  esac
}

if [[ -f "$SCRIPT_DIR/.env.deepseek" ]]; then
  source "$SCRIPT_DIR/.env.deepseek"
fi
export ANTHROPIC_AUTH_TOKEN
export ANTHROPIC_BASE_URL="https://api.deepseek.com/anthropic"

FAMILY="$(selected_family "$@")"
if [[ "$FAMILY" == pro ]]; then
  SELECTED_MAIN="$DEEPSEEK_PRO_MAIN"
  SELECTED_NAME="$DEEPSEEK_PRO_NAME"
else
  SELECTED_MAIN="$DEEPSEEK_FLASH_MAIN"
  SELECTED_NAME="$DEEPSEEK_FLASH_NAME"
fi
DEFAULT_THINKING="$(normalize_deepseek_thinking "${DEEPSEEK_THINKING:-enabled}")"
case "${DEEPSEEK_EFFORT:l}" in
  high|medium|low) DEFAULT_EFFORT="${DEEPSEEK_EFFORT:l}" ;;
  *) DEFAULT_EFFORT="max" ;;
esac

export ANTHROPIC_MODEL="$SELECTED_MAIN"
# DeepSeek's documented Claude Code mapping points the Opus tier at Flash.
# Pinning it to Pro billed Flash-quality output at V4 Pro rates (and since
# 2026-09-14 deepseek-v4-pro requests route to V4.1-Flash 1017 anyway). Pro stays
# reachable via --model pro / DEEPSEEK_VARIANT=pro and the /model picker.
export ANTHROPIC_DEFAULT_OPUS_MODEL="$SELECTED_MAIN"
export ANTHROPIC_DEFAULT_SONNET_MODEL="$SELECTED_MAIN"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="$DEEPSEEK_FLASH_BARE"
export ANTHROPIC_DEFAULT_OPUS_MODEL_NAME="$SELECTED_NAME"
export ANTHROPIC_DEFAULT_SONNET_MODEL_NAME="$SELECTED_NAME"
export ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME="$DEEPSEEK_FLASH_NAME"
export ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION="$SELECTED_NAME via official API - 1M context, max effort"
export ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION="$SELECTED_NAME via official API - 1M context, max effort"
export ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION="$DEEPSEEK_FLASH_NAME via official API - 1M context, max effort"
export CLAUDE_CODE_SUBAGENT_MODEL="${DEEPSEEK_SUBAGENT_MODEL:-$DEEPSEEK_FLASH_BARE}"

export ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES="thinking,effort,max_effort"
export ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES="thinking,effort,max_effort"
export ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES="thinking,effort,max_effort"
export CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1
export MAX_THINKING_TOKENS=16000

export CLAUDE_CODE_MAX_CONTEXT_TOKENS="${CLAUDE_CODE_MAX_CONTEXT_TOKENS:-1048576}"
export CLAUDE_CODE_AUTO_COMPACT_WINDOW="${CLAUDE_CODE_AUTO_COMPACT_WINDOW:-786432}"
export CLAUDE_CODE_MAX_OUTPUT_TOKENS="${CLAUDE_CODE_MAX_OUTPUT_TOKENS:-${DEEPSEEK_MAX_OUTPUT_TOKENS:-64000}}"
export API_TIMEOUT_MS="${API_TIMEOUT_MS:-3000000}"
export CLAUDE_CODE_AUTO_MODE_SERVER="${CLAUDE_CODE_AUTO_MODE_SERVER:-0}"
export CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1
export DISABLE_INTERLEAVED_THINKING=1
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
export CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK=1

python3 - "$CLAUDE_CONFIG_DIR" "$DEEPSEEK_FLASH_MAIN" "$DEEPSEEK_FLASH_NAME" "$DEEPSEEK_PRO_MAIN" "$DEEPSEEK_PRO_NAME" <<'PY' 2>/dev/null || true
import json, pathlib, sys
base = pathlib.Path(sys.argv[1]); base.mkdir(parents=True, exist_ok=True)
flash, flash_name, pro, pro_name = sys.argv[2:6]
options = [
    {
        "value": flash,
        "label": flash_name,
        "description": f"{flash_name} via official API - 1M context, max effort",
        "descriptionForModel": f"{flash_name} via official API - 1M context, max effort",
    },
    {
        "value": pro,
        "label": pro_name,
        "description": f"{pro_name} via official API - 1M context, max effort",
        "descriptionForModel": f"{pro_name} via official API - 1M context, max effort",
    },
]
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
s["availableModels"] = [flash, pro]
sj.write_text(json.dumps(s, indent=2))
PY

forwarded_args=()
i=1
while (( i <= $# )); do
  arg="${@[$i]}"
  if [[ "$arg" == "--model="* ]]; then
    forwarded_args+=("--model=$SELECTED_MAIN")
  elif [[ "$arg" == "--model" && $i -lt $# ]]; then
    forwarded_args+=(--model "$SELECTED_MAIN")
    (( i++ ))
  else
    forwarded_args+=("$arg")
  fi
  (( i++ ))
done

args=()
if ! has_arg "--model" "$@"; then
  args+=(--model "$SELECTED_MAIN")
fi
export CLAUDE_CODE_EFFORT_LEVEL="${CLAUDE_CODE_EFFORT_LEVEL:-$DEFAULT_EFFORT}"
if ! has_arg "--effort" "$@"; then
  args+=(--effort "$CLAUDE_CODE_EFFORT_LEVEL")
fi
if ! has_arg "--thinking" "$@"; then
  args+=(--thinking "$DEFAULT_THINKING")
fi
# shellcheck disable=SC1091
source "$SCRIPT_DIR/scripts/fexor-append-autonomy.inc.sh"
fexor_maybe_append_autonomy "$@"

print -r -- "[launch-deepseek] model=$SELECTED_MAIN  effort=${CLAUDE_CODE_EFFORT_LEVEL}  thinking=${DEFAULT_THINKING}  compact=${CLAUDE_CODE_AUTO_COMPACT_WINDOW}  out=${CLAUDE_CODE_MAX_OUTPUT_TOKENS}  config=${CLAUDE_CONFIG_DIR}"

# shellcheck disable=SC1091
source "$SCRIPT_DIR/scripts/fexor-launcher-env.inc.sh"

exec "$SCRIPT_DIR/cli-dev" "${args[@]}" "${forwarded_args[@]}"
