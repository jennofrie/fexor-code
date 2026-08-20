#!/bin/zsh
# fexor-code isolated launcher — powered by DeepSeek V4-Pro-0813/Flash-0731
# Runs fexor-code with its own config directory, completely separate from
# the official Claude Code CLI (~/.claude/).
#
# Usage:
#   ./launch-deepseek.sh                          # interactive REPL
#   ./launch-deepseek.sh -p "explain this repo"   # one-shot
#   ./launch-deepseek.sh --model deepseek-v4-pro-0813 # latest Pro (hosted alias)
#   ./launch-deepseek.sh --model deepseek-v4-flash-0731 # specify Flash-0731
#   DEEPSEEK_MAX_OUTPUT_TOKENS=384000 ./launch-deepseek.sh # opt into 384K output
#   DEEPSEEK_VARIANT=flash ./launch-deepseek.sh     # default to Flash
#   DEEPSEEK_MODEL=deepseek-v4-flash-0731 ./launch-deepseek.sh
#
# To add a shell alias:
#   echo 'alias fexor-deepseek="~/Desktop/Github/fexor-code-main/launch-deepseek.sh"' >> ~/.zshrc

export CLAUDE_CONFIG_DIR="$HOME/.fexor-code"

# ── Load API key (gitignored) ─────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEFAULT_EFFORT="${DEEPSEEK_EFFORT:-max}"
DEFAULT_THINKING="${DEEPSEEK_THINKING:-adaptive}"
DEEPSEEK_PRO_MODEL="deepseek-v4-pro"
DEEPSEEK_PRO_RELEASE="0813"
# DeepSeek's hosted API keeps stable model IDs. As of 2026-08-13, the Pro alias
# resolves to DeepSeek-V4-Pro-0813; as of 2026-07-31, the Flash alias resolves
# to DeepSeek-V4-Flash-0731. Dated names are checkpoint labels and are normalized
# below because the official hosted API only accepts the stable IDs.
DEEPSEEK_FLASH_MODEL="deepseek-v4-flash"
DEEPSEEK_FLASH_RELEASE="0731"

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

normalize_deepseek_model() {
  local model="${1:l}"
  case "$model" in
    pro|v4-pro|deepseek-pro|pro-0813|v4-pro-0813|deepseek-pro-0813|deepseek-v4-pro-0813)
      echo "$DEEPSEEK_PRO_MODEL"
      ;;
    flash|v4-flash|deepseek-flash|flash-0731|v4-flash-0731|deepseek-flash-0731|deepseek-v4-flash-0731)
      echo "$DEEPSEEK_FLASH_MODEL"
      ;;
    *)
      echo "$1"
      ;;
  esac
}

default_deepseek_model() {
  case "${DEEPSEEK_VARIANT:l}" in
    flash|v4-flash|flash-0731|v4-flash-0731|deepseek-v4-flash-0731)
      echo "$DEEPSEEK_FLASH_MODEL"
      ;;
    pro|v4-pro|pro-0813|v4-pro-0813|deepseek-v4-pro-0813|"")
      echo "$DEEPSEEK_PRO_MODEL"
      ;;
    *)
      echo "[launch-deepseek] ERROR: DEEPSEEK_VARIANT must be 'pro', 'pro-0813', 'flash', or 'flash-0731'." >&2
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
  normalize_deepseek_model "$model"
}

if [[ -f "$SCRIPT_DIR/.env.deepseek" ]]; then
  source "$SCRIPT_DIR/.env.deepseek"
fi
# Hard override — ensures any stale stored key in ~/.fexor-code/ cannot win
export ANTHROPIC_AUTH_TOKEN

# ── DeepSeek V4 — Anthropic-compatible endpoint ───────────────────────────────
export ANTHROPIC_BASE_URL="https://api.deepseek.com/anthropic"

DEFAULT_DEEPSEEK_MODEL="$(normalize_deepseek_model "${DEEPSEEK_MODEL:-$(default_deepseek_model)}")"
SELECTED_DEEPSEEK_MODEL="$(selected_model "$DEFAULT_DEEPSEEK_MODEL" "$@")"

# Pro remains the default flagship. Flash can be selected with --model,
# DEEPSEEK_MODEL, or DEEPSEEK_VARIANT=flash. Keep Opus mapped to Pro so /model
# can always jump back to the strongest DeepSeek tier, while Sonnet and subagents
# follow the selected launcher model.
export ANTHROPIC_MODEL="$SELECTED_DEEPSEEK_MODEL"
export ANTHROPIC_DEFAULT_OPUS_MODEL="$DEEPSEEK_PRO_MODEL"
export ANTHROPIC_DEFAULT_SONNET_MODEL="$SELECTED_DEEPSEEK_MODEL"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="$DEEPSEEK_FLASH_MODEL"
export ANTHROPIC_DEFAULT_OPUS_MODEL_NAME="DeepSeek V4-Pro-${DEEPSEEK_PRO_RELEASE}"
export ANTHROPIC_DEFAULT_SONNET_MODEL_NAME="$([[ "$SELECTED_DEEPSEEK_MODEL" == "$DEEPSEEK_FLASH_MODEL" ]] && echo "DeepSeek V4-Flash-${DEEPSEEK_FLASH_RELEASE}" || echo "DeepSeek V4-Pro-${DEEPSEEK_PRO_RELEASE}")"
export ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME="DeepSeek V4-Flash-${DEEPSEEK_FLASH_RELEASE}"
export ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION="DeepSeek V4-Pro-${DEEPSEEK_PRO_RELEASE} via official API alias - 1M context, 384K max output, max effort"
export ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION="$([[ "$SELECTED_DEEPSEEK_MODEL" == "$DEEPSEEK_FLASH_MODEL" ]] && echo "DeepSeek V4-Flash-${DEEPSEEK_FLASH_RELEASE} via official API alias - 1M context, 384K max output, max effort" || echo "DeepSeek V4-Pro-${DEEPSEEK_PRO_RELEASE} via official API alias - 1M context, 384K max output, max effort")"
export ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION="DeepSeek V4-Flash-${DEEPSEEK_FLASH_RELEASE} via official API alias - 1M context, 384K max output, max effort"
export CLAUDE_CODE_SUBAGENT_MODEL="$(normalize_deepseek_model "${DEEPSEEK_SUBAGENT_MODEL:-$SELECTED_DEEPSEEK_MODEL}")"

# ── Thinking ─────────────────────────────────────────────────────────────────
# NOTE: DeepSeek is classified as a 'firstParty' provider (only ANTHROPIC_BASE_URL
# is set), so ANTHROPIC_DEFAULT_*_MODEL_SUPPORTED_CAPABILITIES is INERT here. The
# launcher injects --effort max and --thinking adaptive by default so fresh sessions
# start at the highest configured reasoning mode without needing /effort max.
export ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES="thinking,adaptive_thinking"
export ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES="thinking,adaptive_thinking"
export ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES="thinking,adaptive_thinking"
# Fallback budget — only reaches the wire if adaptive thinking is disabled (it is a
# no-op while adaptive is active). Set CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1 to use it.
export MAX_THINKING_TOKENS=16000

# ── Maximize the token window (DeepSeek V4 = native 1M context) ──────────────
# Without this, fexor-code budgets an unknown model at only 200K and auto-compacts
# ~5x too early. CLAUDE_CODE_MAX_CONTEXT_TOKENS is a client-side budgeting value
# (never sent to the API) and is honored in external builds after the un-gate patch.
export CLAUDE_CODE_MAX_CONTEXT_TOKENS="${CLAUDE_CODE_MAX_CONTEXT_TOKENS:-1000000}"
# Keep a practical 64K request default while allowing DeepSeek's documented
# 384K maximum when a task genuinely needs one very large response.
export CLAUDE_CODE_MAX_OUTPUT_TOKENS="${CLAUDE_CODE_MAX_OUTPUT_TOKENS:-${DEEPSEEK_MAX_OUTPUT_TOKENS:-64000}}"

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

# Lock /model picker to the official DeepSeek V4 tiers in this isolated config.
python3 - "$CLAUDE_CONFIG_DIR" "$DEEPSEEK_PRO_MODEL" "$DEEPSEEK_PRO_RELEASE" "$DEEPSEEK_FLASH_MODEL" "$DEEPSEEK_FLASH_RELEASE" <<'PY' 2>/dev/null || true
import json, pathlib, sys
base = pathlib.Path(sys.argv[1]); base.mkdir(parents=True, exist_ok=True)
pro = sys.argv[2]
pro_release = sys.argv[3]
flash = sys.argv[4]
flash_release = sys.argv[5]
options = [
    {
        "value": pro,
        "label": f"DeepSeek V4-Pro-{pro_release}",
        "description": f"DeepSeek V4-Pro-{pro_release} via official API alias - 1M context, 384K max output, max effort",
        "descriptionForModel": f"DeepSeek V4-Pro-{pro_release} via official API alias - 1M context, 384K max output, max effort",
    },
    {
        "value": flash,
        "label": f"DeepSeek V4-Flash-{flash_release}",
        "description": f"DeepSeek V4-Flash-{flash_release} via official API alias - 1M context, 384K max output, max effort",
        "descriptionForModel": f"DeepSeek V4-Flash-{flash_release} via official API alias - 1M context, 384K max output, max effort",
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
s["availableModels"] = [pro, flash]
sj.write_text(json.dumps(s, indent=2))
PY

# ── Voice (/voice) ───────────────────────────────────────────────────────────
# Not available on this provider. Speech-to-text uses Anthropic's claude.ai
# voice_stream endpoint (OAuth-gated), so /voice is hidden for API-key providers
# like DeepSeek. Recording (SoX) works, but transcription is claude.ai-only —
# use fexor-launch.sh / launch-claude-opus45.sh for voice.

# Rewrite every explicit model argument to the normalized hosted-API model ID.
# Without this, aliases such as `flash` and the release name
# `deepseek-v4-pro-0813` are selected internally but the original value still
# reaches cli-dev and is rejected by DeepSeek's hosted endpoint.
forwarded_args=()
i=1
while (( i <= $# )); do
  arg="${@[$i]}"
  if [[ "$arg" == "--model="* ]]; then
    forwarded_args+=("--model=$SELECTED_DEEPSEEK_MODEL")
  elif [[ "$arg" == "--model" && $i -lt $# ]]; then
    forwarded_args+=(--model "$SELECTED_DEEPSEEK_MODEL")
    (( i++ ))
  else
    forwarded_args+=("$arg")
  fi
  (( i++ ))
done

args=()
if ! has_arg "--model" "$@"; then
  args+=(--model "$SELECTED_DEEPSEEK_MODEL")
fi
if ! has_arg "--effort" "$@" && [[ -z "$CLAUDE_CODE_EFFORT_LEVEL" ]]; then
  args+=(--effort "$DEFAULT_EFFORT")
fi
if ! has_arg "--thinking" "$@"; then
  args+=(--thinking "$DEFAULT_THINKING")
fi

exec "$SCRIPT_DIR/cli-dev" "${args[@]}" "${forwarded_args[@]}"
