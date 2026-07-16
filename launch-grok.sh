#!/bin/zsh
# fexor-code Grok launcher — xAI via Anthropic-compatible Messages API.
#
# Auth order:
#   1. Grok Build OAuth (~/.grok/auth.json) with refresh via auth.x.ai
#   2. API key: .env.grok / XAI_API_KEY / GROK_API_KEY / macOS Keychain
#
# Usage:
#   ./launch-grok.sh
#   ./launch-grok.sh -p "explain this repo"
#   GROK_MODEL=grok-4.3 ./launch-grok.sh --model grok-4.3
#   FEXOR_GROK_SHOW_CONFIG=1 ./launch-grok.sh
#
# First-time OAuth (if no key and no Grok session):
#   grok login --oauth
#   # remote/SSH:
#   grok login --device-auth
#
# Do NOT set CLAUDE_CODE_USE_OPENAI here — that routes to the Codex/ChatGPT
# adapter, not api.x.ai.

export CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.fexor-code-grok}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Isolate from other launchers and repo-local Anthropic/gateway defaults.
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

if [[ -f "$SCRIPT_DIR/.env.grok" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/.env.grok"
  set +a
fi

GROK_AUTH_FILE="${GROK_AUTH_FILE:-$HOME/.grok/auth.json}"
GROK_OAUTH_CLIENT_ID="${GROK_OAUTH_CLIENT_ID:-b1a00492-073a-47ea-816f-4c329264a828}"
GROK_TOKEN_URL="${GROK_TOKEN_URL:-https://auth.x.ai/oauth2/token}"
# Refresh when access JWT expires within this many seconds (default 5 min).
GROK_OAUTH_REFRESH_SKEW_SECS="${GROK_OAUTH_REFRESH_SKEW_SECS:-300}"

AUTH_SOURCE=""
AUTH_TOKEN=""

# Resolve Grok Build OIDC access token (refresh if needed). Prints token only.
# Exit 0 on success, non-zero if OAuth unavailable.
resolve_grok_oauth_token() {
  GROK_AUTH_FILE="$GROK_AUTH_FILE" \
  GROK_OAUTH_CLIENT_ID="$GROK_OAUTH_CLIENT_ID" \
  GROK_TOKEN_URL="$GROK_TOKEN_URL" \
  GROK_OAUTH_REFRESH_SKEW_SECS="$GROK_OAUTH_REFRESH_SKEW_SECS" \
  GROK_OAUTH_WRITE_BACK="${GROK_OAUTH_WRITE_BACK:-1}" \
  python3 - <<'PY'
import json, os, sys, time, urllib.error, urllib.parse, urllib.request
from pathlib import Path

auth_path = Path(os.environ["GROK_AUTH_FILE"]).expanduser()
if not auth_path.is_file():
    sys.exit(2)

try:
    data = json.loads(auth_path.read_text())
except Exception:
    sys.exit(3)

if not isinstance(data, dict) or not data:
    sys.exit(3)

# Prefer the Grok CLI OIDC entry; fall back to first dict entry.
entry_key = None
entry = None
for k, v in data.items():
    if not isinstance(v, dict):
        continue
    if v.get("auth_mode") == "oidc" or "auth.x.ai" in str(k):
        entry_key, entry = k, v
        break
if entry is None:
    for k, v in data.items():
        if isinstance(v, dict) and (v.get("key") or v.get("access_token")):
            entry_key, entry = k, v
            break
if not entry:
    sys.exit(3)

access = entry.get("key") or entry.get("access_token")
refresh = entry.get("refresh_token")
client_id = (
    entry.get("oidc_client_id")
    or os.environ.get("GROK_OAUTH_CLIENT_ID")
    or "b1a00492-073a-47ea-816f-4c329264a828"
)
token_url = os.environ.get("GROK_TOKEN_URL") or "https://auth.x.ai/oauth2/token"
skew = int(os.environ.get("GROK_OAUTH_REFRESH_SKEW_SECS") or "300")
write_back = os.environ.get("GROK_OAUTH_WRITE_BACK", "1") != "0"

def jwt_exp(token: str):
    try:
        import base64
        parts = token.split(".")
        if len(parts) != 3:
            return None
        pad = "=" * (-len(parts[1]) % 4)
        payload = json.loads(base64.urlsafe_b64decode(parts[1] + pad))
        exp = payload.get("exp")
        return int(exp) if exp is not None else None
    except Exception:
        return None

def needs_refresh(token: str) -> bool:
    if not token:
        return True
    exp = jwt_exp(token)
    if exp is None:
        # Unknown shape; try as-is unless refresh is available and file looks stale.
        return False
    return exp <= int(time.time()) + skew

def do_refresh(refresh_token: str):
    body = urllib.parse.urlencode(
        {
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": client_id,
        }
    ).encode()
    req = urllib.request.Request(
        token_url,
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())

if needs_refresh(access):
    if not refresh:
        sys.exit(4)
    try:
        tok = do_refresh(refresh)
    except urllib.error.HTTPError as e:
        sys.stderr.write(
            f"[launch-grok] OAuth refresh failed HTTP {e.code}\n"
        )
        sys.exit(5)
    except Exception as e:
        sys.stderr.write(f"[launch-grok] OAuth refresh failed: {e}\n")
        sys.exit(5)

    new_access = tok.get("access_token")
    if not new_access:
        sys.exit(5)
    access = new_access
    new_refresh = tok.get("refresh_token") or refresh
    expires_in = tok.get("expires_in")
    entry["key"] = access
    entry["refresh_token"] = new_refresh
    entry["auth_mode"] = entry.get("auth_mode") or "oidc"
    entry["oidc_client_id"] = client_id
    entry["oidc_issuer"] = entry.get("oidc_issuer") or "https://auth.x.ai"
    if isinstance(expires_in, (int, float)):
        # ISO-ish timestamp for humans; JWT exp is authoritative.
        entry["expires_at"] = time.strftime(
            "%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + float(expires_in))
        )
    data[entry_key] = entry
    if write_back:
        try:
            tmp = auth_path.with_suffix(auth_path.suffix + ".tmp")
            tmp.write_text(json.dumps(data, indent=2) + "\n")
            os.chmod(tmp, 0o600)
            tmp.replace(auth_path)
            os.chmod(auth_path, 0o600)
        except Exception as e:
            sys.stderr.write(
                f"[launch-grok] warning: could not write refreshed tokens: {e}\n"
            )

if not access:
    sys.exit(4)

sys.stdout.write(access)
PY
}

# ── 1) OAuth (Grok Build OIDC) ───────────────────────────────────────────────
_GROK_OAUTH_ERR_FILE="$(mktemp -t launch-grok-oauth.XXXXXX 2>/dev/null || mktemp)"
if oauth_token="$(resolve_grok_oauth_token 2>"$_GROK_OAUTH_ERR_FILE")"; then
  AUTH_TOKEN="$oauth_token"
  AUTH_SOURCE="oauth:$GROK_AUTH_FILE"
elif [[ -s "$_GROK_OAUTH_ERR_FILE" ]]; then
  # Non-fatal: fall through to API key. Surface refresh errors only if no key later.
  GROK_OAUTH_ERR="$(cat "$_GROK_OAUTH_ERR_FILE" 2>/dev/null)"
fi
rm -f "$_GROK_OAUTH_ERR_FILE" 2>/dev/null
unset _GROK_OAUTH_ERR_FILE

# ── 2) API key fallback ──────────────────────────────────────────────────────
if [[ -z "$AUTH_TOKEN" ]]; then
  AUTH_TOKEN="${XAI_API_KEY:-${GROK_API_KEY:-}}"
  if [[ -n "$AUTH_TOKEN" ]]; then
    AUTH_SOURCE="env:XAI_API_KEY/GROK_API_KEY"
  fi
fi

if [[ -z "$AUTH_TOKEN" ]]; then
  AUTH_TOKEN="$(security find-generic-password -s xai_api_key -w 2>/dev/null)"
  if [[ -n "$AUTH_TOKEN" ]]; then
    AUTH_SOURCE="keychain:xai_api_key"
  fi
fi
if [[ -z "$AUTH_TOKEN" ]]; then
  AUTH_TOKEN="$(security find-generic-password -s grok_api_key -w 2>/dev/null)"
  if [[ -n "$AUTH_TOKEN" ]]; then
    AUTH_SOURCE="keychain:grok_api_key"
  fi
fi

if [[ -z "$AUTH_TOKEN" ]]; then
  echo "[launch-grok] ERROR: no xAI credentials found." >&2
  echo "  OAuth (preferred): sign in with Grok Build, then re-run this launcher:" >&2
  echo "    grok login --oauth" >&2
  echo "    grok login --device-auth   # headless / SSH" >&2
  echo "  API key fallback:" >&2
  echo "    export XAI_API_KEY='xai-...'" >&2
  echo "    # or gitignored .env.grok with XAI_API_KEY=..." >&2
  echo "    security add-generic-password -a \"\$USER\" -s xai_api_key -T /usr/bin/security -w 'xai-...' -U" >&2
  if [[ -n "${GROK_OAUTH_ERR:-}" ]]; then
    echo "  OAuth attempt detail:" >&2
    print -r -- "    $GROK_OAUTH_ERR" >&2
  fi
  exit 1
fi

# OAuth JWTs must be Bearer only (x-api-key rejects them). Console keys also
# work as Bearer on api.x.ai. Never put an OAuth JWT in ANTHROPIC_API_KEY.
export ANTHROPIC_AUTH_TOKEN="$AUTH_TOKEN"
if [[ "$AUTH_SOURCE" != oauth:* && "$AUTH_TOKEN" == xai-* ]]; then
  # Optional dual-set for key-shaped secrets (mirrors GLM launcher).
  export ANTHROPIC_API_KEY="$AUTH_TOKEN"
fi
unset AUTH_TOKEN
unset XAI_API_KEY
unset GROK_API_KEY

# firstParty path: Anthropic Messages → https://api.x.ai/v1/messages
export ANTHROPIC_BASE_URL="${GROK_BASE_URL:-${ANTHROPIC_BASE_URL:-https://api.x.ai}}"

DEFAULT_GROK_MODEL="${GROK_MODEL:-grok-4.5}"
FAST_GROK_MODEL="${GROK_FAST_MODEL:-grok-4.3}"
SELECTED_GROK_MODEL="$(selected_model "$DEFAULT_GROK_MODEL" "$@")"

export ANTHROPIC_MODEL="$SELECTED_GROK_MODEL"
export ANTHROPIC_DEFAULT_OPUS_MODEL="${ANTHROPIC_DEFAULT_OPUS_MODEL:-$DEFAULT_GROK_MODEL}"
export ANTHROPIC_DEFAULT_SONNET_MODEL="${ANTHROPIC_DEFAULT_SONNET_MODEL:-$SELECTED_GROK_MODEL}"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="${ANTHROPIC_DEFAULT_HAIKU_MODEL:-$FAST_GROK_MODEL}"
export ANTHROPIC_DEFAULT_OPUS_MODEL_NAME="${ANTHROPIC_DEFAULT_OPUS_MODEL_NAME:-Grok 4.5}"
export ANTHROPIC_DEFAULT_SONNET_MODEL_NAME="${ANTHROPIC_DEFAULT_SONNET_MODEL_NAME:-Grok}"
export ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME="${ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME:-Grok 4.3}"
export ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION="xAI Grok via Anthropic-compatible API"
export ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION="xAI Grok via Anthropic-compatible API"
export ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION="xAI Grok (faster tier) via Anthropic-compatible API"
export CLAUDE_CODE_SUBAGENT_MODEL="${GROK_SUBAGENT_MODEL:-$SELECTED_GROK_MODEL}"

# Client-side context budget (not sent to the API). grok-4.5 docs list 500k.
export CLAUDE_CODE_MAX_CONTEXT_TOKENS="${CLAUDE_CODE_MAX_CONTEXT_TOKENS:-500000}"
export CLAUDE_CODE_MAX_OUTPUT_TOKENS="${CLAUDE_CODE_MAX_OUTPUT_TOKENS:-${GROK_MAX_OUTPUT_TOKENS:-64000}}"
export API_TIMEOUT_MS="${API_TIMEOUT_MS:-600000}"

# Unknown models default to firstParty heuristics; strip Anthropic-only extras.
export CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS="${CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS:-1}"
export DISABLE_INTERLEAVED_THINKING="${DISABLE_INTERLEAVED_THINKING:-1}"
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="${CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:-1}"
# xAI's Anthropic-compatible stream reuses content_block index 0 for thinking
# then text, which trips fexor's stream assembler ("Content block not found").
# Keep non-streaming fallback ENABLED so requests recover automatically.
# Override with CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK=1 only for debugging.
export CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK="${CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK:-0}"

# Lock /model picker options in this isolated config.
python3 - "$CLAUDE_CONFIG_DIR" "$DEFAULT_GROK_MODEL" "$FAST_GROK_MODEL" <<'PY' 2>/dev/null || true
import json, pathlib, sys
base = pathlib.Path(sys.argv[1]); base.mkdir(parents=True, exist_ok=True)
flagship = sys.argv[2]
fast = sys.argv[3]
options = [
    {
        "value": flagship,
        "label": "Grok 4.5",
        "description": "xAI Grok 4.5 via Anthropic-compatible API",
        "descriptionForModel": "xAI Grok 4.5 via Anthropic-compatible API",
    },
    {
        "value": fast,
        "label": "Grok 4.3",
        "description": "xAI Grok 4.3 via Anthropic-compatible API",
        "descriptionForModel": "xAI Grok 4.3 via Anthropic-compatible API",
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
s["model"] = flagship
s["availableModels"] = [flagship, fast]
sj.write_text(json.dumps(s, indent=2))
PY

if [[ "${FEXOR_GROK_SHOW_CONFIG:-0}" = "1" ]]; then
  {
    print -r -- "Grok launcher config:"
    print -r -- "  auth=$AUTH_SOURCE"
    print -r -- "  ANTHROPIC_BASE_URL=$ANTHROPIC_BASE_URL"
    print -r -- "  ANTHROPIC_MODEL=$ANTHROPIC_MODEL"
    print -r -- "  CLAUDE_CODE_SUBAGENT_MODEL=$CLAUDE_CODE_SUBAGENT_MODEL"
    print -r -- "  CLAUDE_CODE_MAX_CONTEXT_TOKENS=$CLAUDE_CODE_MAX_CONTEXT_TOKENS"
    print -r -- "  CLAUDE_CONFIG_DIR=$CLAUDE_CONFIG_DIR"
    print -r -- "  CLAUDE_CODE_USE_OPENAI=${CLAUDE_CODE_USE_OPENAI:-<unset>}"
  } >&2
fi

# Voice (/voice) is claude.ai OAuth-only — not available on xAI credentials.

args=()
if ! has_arg "--model" "$@"; then
  args+=(--model "$SELECTED_GROK_MODEL")
fi

exec "$SCRIPT_DIR/cli-dev" "${args[@]}" "$@"
