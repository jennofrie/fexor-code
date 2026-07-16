#Requires -Version 5.1
# Clean Anthropic subscription launcher for Windows. This path intentionally
# uses the logged-in claude.ai OAuth session from %APPDATA%\claude, not
# external API tokens.
#
# Usage:
#   .\fexor-launch.ps1                            # interactive REPL (Sonnet 4.6)
#   .\fexor-launch.ps1 -p "your prompt"           # one-shot
#   $env:FEXOR_MODEL="opus"; .\fexor-launch.ps1   # use Opus 4.8
#   $env:FEXOR_1M=1; .\fexor-launch.ps1           # enable 1M context
#
# Voice (/voice): Not available on Windows via this launcher.
# Use the claude.ai web interface or a Mac with SoX for voice.

$ErrorActionPreference = "Stop"

$ScriptDir = $PSScriptRoot
$defaultModel    = if ($env:FEXOR_MODEL) { $env:FEXOR_MODEL } else { "sonnet" }
$defaultEffort   = "high"
$defaultThinking = "adaptive"

# ── Apply 1M context opt-in ───────────────────────────────────────────────────
if ($env:FEXOR_1M -and $defaultModel -notlike '*[1m]*') {
    $defaultModel = "${defaultModel}[1m]"
}

# ── Helpers ───────────────────────────────────────────────────────────────────
function Has-Arg([string]$Needle, [string[]]$ArgList) {
    foreach ($a in $ArgList) {
        if ($a -eq $Needle -or $a -like "$Needle=*") { return $true }
    }
    return $false
}

# ── Clear all provider / key env to ensure OAuth-clean session ───────────────
Remove-Item Env:\ANTHROPIC_MODEL -ErrorAction SilentlyContinue
foreach ($v in @(
    'ANTHROPIC_DEFAULT_OPUS_MODEL','ANTHROPIC_DEFAULT_SONNET_MODEL','ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME','ANTHROPIC_DEFAULT_SONNET_MODEL_NAME',
    'CLAUDE_CODE_SUBAGENT_MODEL','CLAUDE_CODE_MAX_CONTEXT_TOKENS',
    'CLAUDE_CODE_DISABLE_1M_CONTEXT','CLAUDE_CONFIG_DIR',
    'CLAUDE_CODE_USE_OPENAI','CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY'
)) { Remove-Item "Env:\$v" -ErrorAction SilentlyContinue }

$env:ANTHROPIC_API_KEY                         = $null
$env:ANTHROPIC_AUTH_TOKEN                      = $null
$env:ANTHROPIC_CUSTOM_HEADERS                  = $null
$env:CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR       = $null
$env:CLAUDE_CODE_OAUTH_TOKEN                   = $null
$env:CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR   = $null
$env:CLAUDE_CODE_OAUTH_REFRESH_TOKEN           = $null

# ── Anthropic endpoint and model defaults ─────────────────────────────────────
$env:ANTHROPIC_BASE_URL                       = "https://api.anthropic.com"
$env:ANTHROPIC_DEFAULT_OPUS_MODEL             = "claude-opus-4-8"
$env:ANTHROPIC_DEFAULT_OPUS_MODEL_NAME        = "Claude Opus 4.8"
$env:ANTHROPIC_DEFAULT_SONNET_MODEL           = "claude-sonnet-4-6"
$env:ANTHROPIC_DEFAULT_SONNET_MODEL_NAME      = "Claude Sonnet 4.6"
$env:ANTHROPIC_CUSTOM_MODEL_OPTION            = "sonnet"
$env:ANTHROPIC_CUSTOM_MODEL_OPTION_NAME       = "Sonnet 4.6"
$env:ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION = "Regular Sonnet 4.6 context"
$env:CLAUDE_CODE_SUBAGENT_MODEL               = $defaultModel

# ── Build args and launch ─────────────────────────────────────────────────────
$launchArgs = [System.Collections.Generic.List[string]]::new()

if (-not (Has-Arg '--model' $args)) {
    $launchArgs.Add('--model'); $launchArgs.Add($defaultModel)
}
if (-not (Has-Arg '--effort' $args) -and -not $env:CLAUDE_CODE_EFFORT_LEVEL) {
    $launchArgs.Add('--effort'); $launchArgs.Add($defaultEffort)
}
if (-not (Has-Arg '--thinking' $args)) {
    $launchArgs.Add('--thinking'); $launchArgs.Add($defaultThinking)
}
if (-not (Has-Arg '--setting-sources' $args) -and -not (Has-Arg '--settings' $args)) {
    # Only inject --setting-sources when a real value exists (e.g., FEXOR_VOICE=1 → 'user').
    # PS5.1 drops empty strings during array splatting, so skip when empty.
    $settingSrc = if ($env:FEXOR_VOICE) { 'user' } else { '' }
    if ($settingSrc -ne '') {
        $launchArgs.Add('--setting-sources'); $launchArgs.Add($settingSrc)
    }
}

$launchArgs.AddRange([string[]]$args)

$cliBin = Join-Path $ScriptDir "cli-dev.exe"
if (-not (Test-Path $cliBin)) { $cliBin = Join-Path $ScriptDir "cli-dev" }
& $cliBin @launchArgs
exit $LASTEXITCODE
