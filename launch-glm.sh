#!/bin/zsh
# fexor-code GLM launcher - Z.AI Anthropic Messages endpoint.
#
# Usage:
#   ./launch-glm.sh
#   # Run the same command in up to three terminals; a fourth launch is rejected.
#   ./launch-glm.sh -p "review this change"
#   GLM_MODEL=glm-5.2 ./launch-glm.sh --model glm-5.2
#   GLM_MODEL=glm-5.3[1m] ./launch-glm.sh --model glm-5.3[1m]
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

GLM_MAX_INSTANCES=3
GLM_LAUNCH_STATE_DIR="$CLAUDE_CONFIG_DIR/.glm-launch-slots"
GLM_LAUNCH_LOCK="$GLM_LAUNCH_STATE_DIR/.lock"
GLM_PROCESS_OWNER=""

process_owner() {
  local pid="$1"
  local started_at
  if [[ ! "$pid" =~ '^[1-9][0-9]*$' ]]; then
    return 1
  fi
  started_at="$(ps -p "$pid" -o lstart= 2>/dev/null)" || return 1
  if [[ -z "$started_at" ]]; then
    return 1
  fi
  print -r -- "$pid|$started_at"
}

owner_is_live() {
  local owner="$1"
  local pid
  if [[ "$owner" != *"|"* ]]; then
    return 1
  fi
  pid="${owner%%|*}"
  [[ "$(process_owner "$pid")" == "$owner" ]]
}

running_glm_pids() {
  local pid command
  while read -r pid command; do
    if [[ ( "$command" == "$SCRIPT_DIR/cli-dev" || "$command" == "$SCRIPT_DIR/cli-dev "* ) &&
          ( "$command" == *"--model glm-"* || "$command" == *"--model=glm-"* ) ]]; then
      print -r -- "$pid"
    fi
  done < <(ps -axo pid=,command=)
}

release_glm_launch_lock() {
  local lock_owner
  lock_owner="$(readlink "$GLM_LAUNCH_LOCK" 2>/dev/null)" || return 0
  if [[ "$lock_owner" == "$GLM_PROCESS_OWNER" ]]; then
    rm -f -- "$GLM_LAUNCH_LOCK"
  fi
}

acquire_glm_launch_lock() {
  local attempt lock_owner
  mkdir -p "$GLM_LAUNCH_STATE_DIR" || return 1
  chmod 700 "$GLM_LAUNCH_STATE_DIR" 2>/dev/null || true
  GLM_PROCESS_OWNER="$(process_owner "$$")" || return 1

  for (( attempt = 1; attempt <= 100; attempt++ )); do
    if ln -s "$GLM_PROCESS_OWNER" "$GLM_LAUNCH_LOCK" 2>/dev/null; then
      trap release_glm_launch_lock EXIT
      return 0
    fi
    if [[ -L "$GLM_LAUNCH_LOCK" ]]; then
      lock_owner="$(readlink "$GLM_LAUNCH_LOCK" 2>/dev/null)"
      if ! owner_is_live "$lock_owner"; then
        rm -f -- "$GLM_LAUNCH_LOCK"
        continue
      fi
    elif [[ -e "$GLM_LAUNCH_LOCK" ]]; then
      echo "[launch-glm] ERROR: invalid launch-lock state at $GLM_LAUNCH_LOCK." >&2
      return 1
    fi
    sleep 0.05
  done

  echo "[launch-glm] ERROR: timed out waiting for the GLM launch lock." >&2
  return 1
}

slot_has_owner() {
  local wanted_owner="$1"
  local index slot owner
  for (( index = 1; index <= GLM_MAX_INSTANCES; index++ )); do
    slot="$GLM_LAUNCH_STATE_DIR/slot-$index"
    owner="$(readlink "$slot" 2>/dev/null)" || continue
    if [[ "$owner" == "$wanted_owner" ]]; then
      return 0
    fi
  done
  return 1
}

reserve_glm_slot() {
  local owner="$1"
  local index slot
  for (( index = 1; index <= GLM_MAX_INSTANCES; index++ )); do
    slot="$GLM_LAUNCH_STATE_DIR/slot-$index"
    if ln -s "$owner" "$slot" 2>/dev/null; then
      return 0
    fi
  done
  return 1
}

claim_glm_launch_slot() {
  local index slot owner pid
  if ! acquire_glm_launch_lock; then
    return 1
  fi

  # Reclaim slots left by clean exits, crashes, or PID reuse.
  for (( index = 1; index <= GLM_MAX_INSTANCES; index++ )); do
    slot="$GLM_LAUNCH_STATE_DIR/slot-$index"
    if [[ -L "$slot" ]]; then
      owner="$(readlink "$slot" 2>/dev/null)"
      if ! owner_is_live "$owner"; then
        rm -f -- "$slot"
      fi
    elif [[ -e "$slot" ]]; then
      echo "[launch-glm] ERROR: invalid launch-slot state at $slot." >&2
      return 1
    fi
  done

  # Adopt sessions started by the previous launcher implementation so an
  # in-place upgrade cannot temporarily exceed the three-instance cap.
  while IFS= read -r pid; do
    owner="$(process_owner "$pid")" || continue
    if ! slot_has_owner "$owner"; then
      reserve_glm_slot "$owner" || break
    fi
  done < <(running_glm_pids)

  if ! reserve_glm_slot "$GLM_PROCESS_OWNER"; then
    echo "[launch-glm] ERROR: $GLM_MAX_INSTANCES GLM fexor-code instances are already running (maximum $GLM_MAX_INSTANCES)." >&2
    echo "  Close one GLM session, then run ./launch-glm.sh again." >&2
    return 1
  fi

  release_glm_launch_lock
  trap - EXIT
  return 0
}

if ! claim_glm_launch_slot; then
  exit 1
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

# Z.AI documents GLM 1M mode for Claude Code with the [1m] suffix.
DEFAULT_GLM_MODEL="${GLM_MODEL:-glm-5.2[1m]}"
GLM_53_MODEL="${GLM_53_MODEL:-glm-5.3[1m]}"
SELECTED_GLM_MODEL="$(selected_model "$DEFAULT_GLM_MODEL" "$@")"
case "$SELECTED_GLM_MODEL" in
  *5.3*) GLM_LABEL="GLM-5.3"; GLM_DESC="Z.AI GLM-5.3 via Anthropic API - 1M context, max effort" ;;
  *)     GLM_LABEL="GLM-5.2"; GLM_DESC="Z.AI GLM-5.2 via Anthropic API - 1M context, max effort" ;;
esac

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

# GLM-5.2 and GLM-5.3 advertise high/max reasoning effort. The source allowlist
# preserves max instead of clamping it to high.
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

# Lock /model to the GLM choices in this isolated config. Writes are atomic so
# simultaneous launcher starts cannot leave either shared JSON file truncated.
python3 - "$CLAUDE_CONFIG_DIR" "$DEFAULT_GLM_MODEL" "$ANTHROPIC_DEFAULT_HAIKU_MODEL" "$GLM_53_MODEL" <<'PY' 2>/dev/null || true
import json, os, pathlib, sys
base = pathlib.Path(sys.argv[1]); base.mkdir(parents=True, exist_ok=True)
glm = sys.argv[2]
haiku = sys.argv[3]
glm53 = sys.argv[4]

def atomic_write_json(path, data):
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        with tmp.open("w", encoding="utf-8") as handle:
            json.dump(data, handle, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    finally:
        try: tmp.unlink()
        except FileNotFoundError: pass

options = [
    {
        "value": glm53,
        "label": "GLM-5.3 (1M context)",
        "description": "Z.AI GLM-5.3 via Anthropic API - 1M context, max effort",
        "descriptionForModel": "Z.AI GLM-5.3 via Anthropic API - 1M context, max effort",
    },
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
if d.get("additionalModelOptionsCache") != options:
    d["additionalModelOptionsCache"] = options
    atomic_write_json(cj, d)

sj = base / "settings.json"
try: s = json.loads(sj.read_text())
except Exception: s = {}
available_models = [glm53, glm, haiku]
if s.get("model") != glm or s.get("availableModels") != available_models:
    s["model"] = glm
    s["availableModels"] = available_models
    atomic_write_json(sj, s)
PY

# Voice (/voice) is claude.ai OAuth-only in this codebase, so external API-key
# providers like GLM should use the Claude launchers for voice transcription.

GLM_DEFAULT_AUTONOMY_PROMPT_FILE="${GLM_AUTONOMY_PROMPT_FILE:-$SCRIPT_DIR/prompts/glm-autonomy-system-prompt.md}"
FEXOR_CODING_PROMPT_FILE="$SCRIPT_DIR/prompts/glm-coding-harness-prompt.md"
FEXOR_LSP_SETTINGS_FILE="$SCRIPT_DIR/prompts/harness-lsp-settings.json"
FEXOR_HARNESS_ENABLED=0
FEXOR_HARNESS_LSP_ENABLED=0
FEXOR_HARNESS_PROMPT_ENABLED=0

# The coding harness is deliberately opt-in. Keep all legacy launcher defaults
# byte-for-byte equivalent unless the caller selects the exact master value 1.
if [[ "${FEXOR_CODING_HARNESS:-0}" == "1" ]]; then
  FEXOR_HARNESS_ENABLED=1
  export FEXOR_CODING_HARNESS=1
  export FEXOR_ENABLE_VERIFICATION_AGENT="${FEXOR_ENABLE_VERIFICATION_AGENT:-1}"
  export FEXOR_ENABLE_CODING_PROMPT="${FEXOR_ENABLE_CODING_PROMPT:-1}"

  case "$FEXOR_ENABLE_CODING_PROMPT" in
    1|true|TRUE|yes|YES|on|ON) FEXOR_HARNESS_PROMPT_ENABLED=1 ;;
  esac

  case "${ENABLE_LSP_TOOL:-1}" in
    1|true|TRUE|yes|YES|on|ON)
      if [[ -f "$FEXOR_LSP_SETTINGS_FILE" ]]; then
        export ENABLE_LSP_TOOL=1
        FEXOR_HARNESS_LSP_ENABLED=1
        if [[ ! -d "$CLAUDE_CONFIG_DIR/plugins/cache/claude-plugins-official/rust-analyzer-lsp" ]]; then
          echo "[launch-glm] WARNING: rust-analyzer-lsp plugin is enabled but not installed in $CLAUDE_CONFIG_DIR/plugins/." >&2
        fi
        if ! command -v rust-analyzer >/dev/null 2>&1 || ! rust-analyzer --version >/dev/null 2>&1; then
          echo "[launch-glm] WARNING: rust-analyzer is unavailable or its PATH shim is broken (install with: rustup component add rust-analyzer, or brew install rust-analyzer)." >&2
        fi
      fi
      ;;
  esac
fi

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
if ! has_arg "--append-system-prompt" "$@" && ! has_arg "--append-system-prompt-file" "$@"; then
  if (( FEXOR_HARNESS_PROMPT_ENABLED )) && [[ -f "$FEXOR_CODING_PROMPT_FILE" ]]; then
    if [[ "${FEXOR_AUTONOMY_PROMPT:-1}" != "0" && "${FEXOR_DISABLE_AUTONOMY_PROMPT:-0}" != "1" && "${GLM_AUTONOMY_PROMPT:-1}" != "0" && "${GLM_DISABLE_AUTONOMY_PROMPT:-0}" != "1" && -f "$GLM_DEFAULT_AUTONOMY_PROMPT_FILE" ]]; then
      args+=(--append-system-prompt "$(<"$GLM_DEFAULT_AUTONOMY_PROMPT_FILE")

$(<"$FEXOR_CODING_PROMPT_FILE")")
    else
      args+=(--append-system-prompt-file "$FEXOR_CODING_PROMPT_FILE")
    fi
  elif [[ "${FEXOR_AUTONOMY_PROMPT:-1}" != "0" && "${FEXOR_DISABLE_AUTONOMY_PROMPT:-0}" != "1" && "${GLM_AUTONOMY_PROMPT:-1}" != "0" && "${GLM_DISABLE_AUTONOMY_PROMPT:-0}" != "1" && -f "$GLM_DEFAULT_AUTONOMY_PROMPT_FILE" ]]; then
    args+=(--append-system-prompt-file "$GLM_DEFAULT_AUTONOMY_PROMPT_FILE")
  fi
fi
if (( FEXOR_HARNESS_ENABLED )); then
  if ! has_arg "--setting-sources" "$@" && ! has_arg "--settings" "$@" && (( FEXOR_HARNESS_LSP_ENABLED )); then
    args+=(--setting-sources "" --settings "$FEXOR_LSP_SETTINGS_FILE")
  elif ! has_arg "--setting-sources" "$@" && ! has_arg "--settings" "$@"; then
    args+=(--setting-sources "")
  fi
elif ! has_arg "--setting-sources" "$@"; then
  # Exact legacy behavior while the master switch is off: an explicit
  # --settings argument did not suppress the empty setting-sources default.
  args+=(--setting-sources "")
fi

exec "$SCRIPT_DIR/cli-dev" "${args[@]}" "$@"
