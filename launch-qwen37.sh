#!/bin/zsh
# fexor-code Qwen 3.7 Max launcher — Anthropic Messages -> Alibaba Model Studio.
#
# This is intentionally isolated from the Venice, DeepSeek, GPT, and Claude
# launchers:
#   - own CLAUDE_CONFIG_DIR=~/.fexor-code-qwen37
#   - reads qwen37_api_key from macOS Keychain or .env.qwen37
#   - does not start LiteLLM and does not modify existing binaries
#
# Usage:
#   ./launch-qwen37.sh
#   ./launch-qwen37.sh -p "review this change"
#   QWEN37_MODEL=qwen3.7-max ./launch-qwen37.sh --model qwen3.7-max

export CLAUDE_CONFIG_DIR="$HOME/.fexor-code-qwen37"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── Defensive: clear any provider env that may have leaked from a parent shell ─
unset CLAUDE_CODE_USE_OPENAI
unset CLAUDE_CODE_USE_BEDROCK
unset CLAUDE_CODE_USE_VERTEX
unset CLAUDE_CODE_USE_FOUNDRY
unset ANTHROPIC_CUSTOM_HEADERS
unset CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR
unset CLAUDE_CODE_OAUTH_TOKEN
unset CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR
unset CLAUDE_CODE_OAUTH_REFRESH_TOKEN

# ── Load API key ─────────────────────────────────────────────────────────────
# Preferred:
#   security add-generic-password -a "$USER" -s qwen37_api_key -T /usr/bin/security -w 'YOUR_KEY' -U
#
# Fallback, still ignored by git:
#   echo 'export QWEN37_API_KEY="YOUR_KEY"' > .env.qwen37
if [[ -f "$SCRIPT_DIR/.env.qwen37" ]]; then
  set -a
  source "$SCRIPT_DIR/.env.qwen37"
  set +a
fi

if [[ -z "$QWEN37_API_KEY" ]]; then
  QWEN37_API_KEY="$(security find-generic-password -s qwen37_api_key -w 2>/dev/null)"
fi

if [[ -z "$QWEN37_API_KEY" ]]; then
  echo "[launch-qwen37] ERROR: qwen37_api_key not found in macOS Keychain and QWEN37_API_KEY is unset." >&2
  echo "  Add it with:" >&2
  echo "    security add-generic-password -a \"\$USER\" -s qwen37_api_key -T /usr/bin/security -w 'YOUR_KEY' -U" >&2
  echo "  Or create gitignored .env.qwen37 with:" >&2
  echo "    export QWEN37_API_KEY='YOUR_KEY'" >&2
  exit 1
fi

# The local client supports both Anthropic SDK apiKey and bearer-token auth.
# Set both for compatibility with Anthropic-protocol gateways.
export ANTHROPIC_API_KEY="$QWEN37_API_KEY"
export ANTHROPIC_AUTH_TOKEN="$QWEN37_API_KEY"
unset QWEN37_API_KEY

# ── Alibaba Model Studio Anthropic-compatible endpoint ──────────────────────
# Token Plan Team Edition keys use a dedicated endpoint and are not
# interchangeable with regular pay-as-you-go DashScope keys.
if [[ -z "$ANTHROPIC_BASE_URL" ]]; then
  if [[ "$ANTHROPIC_AUTH_TOKEN" == sk-sp-* ]]; then
    export ANTHROPIC_BASE_URL="https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic"
  else
    export ANTHROPIC_BASE_URL="https://dashscope-intl.aliyuncs.com/apps/anthropic"
  fi
fi

QWEN_MODEL="${QWEN37_MODEL:-qwen3.7-max}"
export ANTHROPIC_MODEL="${ANTHROPIC_MODEL:-$QWEN_MODEL}"
export ANTHROPIC_DEFAULT_OPUS_MODEL="${ANTHROPIC_DEFAULT_OPUS_MODEL:-$QWEN_MODEL}"
export ANTHROPIC_DEFAULT_SONNET_MODEL="${ANTHROPIC_DEFAULT_SONNET_MODEL:-$QWEN_MODEL}"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="${ANTHROPIC_DEFAULT_HAIKU_MODEL:-$QWEN_MODEL}"
export ANTHROPIC_DEFAULT_OPUS_MODEL_NAME="${ANTHROPIC_DEFAULT_OPUS_MODEL_NAME:-Qwen 3.7 Max}"
export ANTHROPIC_DEFAULT_SONNET_MODEL_NAME="${ANTHROPIC_DEFAULT_SONNET_MODEL_NAME:-Qwen 3.7 Max}"
export ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME="${ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME:-Qwen 3.7 Max}"
export CLAUDE_CODE_SUBAGENT_MODEL="${CLAUDE_CODE_SUBAGENT_MODEL:-$QWEN_MODEL}"

# Keep Anthropic-format prompt caching enabled. The app already places stable
# cache_control markers on system/user blocks; direct Anthropic-compatible Qwen
# should preserve that path, unlike the Venice Chat Completions proxy.
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
export CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK=1

# ── Maximize the token window (Qwen 3.7-Max = native 1M context) ─────────────
# The picker description advertised "1M context" but the model id carries no [1m]
# suffix, so fexor-code was budgeting only the 200K default and auto-compacting far
# too early. CLAUDE_CODE_MAX_CONTEXT_TOKENS sets the real window client-side (never
# sent to the API); we do NOT use the [1m] suffix because it would inject the
# Anthropic-only context-1m beta that Alibaba's endpoint rejects.
export CLAUDE_CODE_MAX_CONTEXT_TOKENS="${CLAUDE_CODE_MAX_CONTEXT_TOKENS:-1000000}"
# Qwen 3.7-Max supports large outputs; lift the per-turn ceiling to fexor-code's
# max for an unknown model (64K).
export CLAUDE_CODE_MAX_OUTPUT_TOKENS="${CLAUDE_CODE_MAX_OUTPUT_TOKENS:-64000}"

# ── 3rd-party fidelity: strip Anthropic-only betas + experimental tool fields ─
# Was MISSING. Alibaba's Anthropic-compatible endpoint is core-Messages only, so
# this suppresses prompt-caching-scope/context-management/redact-thinking betas and
# strips strict/defer_loading/eager_input_streaming from tool schemas (prevents 400s),
# while preserving base cache_control. Single biggest tool-reliability fix here.
export CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS="${CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS:-1}"
# interleaved-thinking is granted by the firstParty heuristic and not stripped above.
# Flip to 0 if Model Studio accepts the interleaved-thinking-2025-05-14 beta.
export DISABLE_INTERLEAVED_THINKING="${DISABLE_INTERLEAVED_THINKING:-1}"

# Reasoning via the Anthropic-compatible path. NOTE: SUPPORTED_CAPABILITIES is INERT
# for Qwen (firstParty providers skip the override) — adaptive thinking is granted by
# heuristics, so {type:'adaptive'} is already sent. effort/max_effort/interleaved were
# trimmed because they only added proprietary wire artifacts. MAX_THINKING_TOKENS is a
# no-op while adaptive is active; kept as a fallback for CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1.
export MAX_THINKING_TOKENS="${MAX_THINKING_TOKENS:-16000}"
export ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES="${ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES:-thinking,adaptive_thinking}"
export ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES="${ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES:-thinking,adaptive_thinking}"
export ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES="${ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES:-thinking}"

# Lock /model picker to the direct Qwen model so generic Anthropic rows do not
# appear in this isolated config.
python3 - "$CLAUDE_CONFIG_DIR" "$QWEN_MODEL" <<'PY' 2>/dev/null || true
import json, pathlib, sys
base = pathlib.Path(sys.argv[1]); base.mkdir(parents=True, exist_ok=True)
model = sys.argv[2]
label = "Qwen 3.7 Max"
desc = "Alibaba Qwen 3.7 Max via Model Studio Anthropic API - 1M context, prompt caching preserved"

cj = base / ".claude.json"
try: d = json.loads(cj.read_text())
except Exception: d = {}
d["additionalModelOptionsCache"] = [
    {"value": model, "label": label, "description": desc, "descriptionForModel": desc}
]
cj.write_text(json.dumps(d, indent=2))

sj = base / "settings.json"
try: s = json.loads(sj.read_text())
except Exception: s = {}
s["availableModels"] = [model]
sj.write_text(json.dumps(s, indent=2))
PY

# ── Voice (/voice) ───────────────────────────────────────────────────────────
# Not available on this provider. Speech-to-text uses Anthropic's claude.ai
# voice_stream endpoint (OAuth-gated), so /voice is hidden for API-key providers
# like Qwen. Recording (SoX) works, but transcription is claude.ai-only —
# use fexor-launch.sh for voice.

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

args=()
# shellcheck disable=SC1091
source "$SCRIPT_DIR/scripts/fexor-append-autonomy.inc.sh"
fexor_maybe_append_autonomy "$@"

exec "$SCRIPT_DIR/cli-dev" "${args[@]}" "$@"
