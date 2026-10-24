# Shared launch-time defaults for Fexor Code 2.1.309.
# Dot-source after provider-specific setup; existing values win.
#
# Never enable the server-side auto-mode classifier in a red-team launcher.
# Fexor's current source does not read this variable; it is kept for
# upstream-compatible builds. Opt in explicitly with ...=1 if ever needed.
if (-not $env:CLAUDE_CODE_AUTO_MODE_SERVER) { $env:CLAUDE_CODE_AUTO_MODE_SERVER = "0" }
if (-not $env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC) { $env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1" }
if (-not $env:CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS) { $env:CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS = "20" }
if (-not $env:CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION) { $env:CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION = "200" }
