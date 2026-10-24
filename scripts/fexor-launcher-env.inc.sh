# Shared launch-time defaults for Fexor Code 2.1.309.
# Source after provider-specific setup so explicit launcher/user values win.
#
# Never enable the server-side auto-mode classifier in a red-team launcher.
# Fexor's current source does not read this variable; it is kept for
# upstream-compatible builds. Opt in explicitly with ...=1 if ever needed.
export CLAUDE_CODE_AUTO_MODE_SERVER="${CLAUDE_CODE_AUTO_MODE_SERVER:-0}"
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="${CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:-1}"
export CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS="${CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS:-20}"
export CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION="${CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION:-200}"
