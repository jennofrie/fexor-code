#Requires -Version 5.1
# fexor-code isolated launcher for Windows — DeepSeek V4-Pro/Flash with thinking.
#
# Usage:
#   .\launch-deepseek.ps1                          # interactive REPL
#   .\launch-deepseek.ps1 -p "explain this repo"   # one-shot
#   .\launch-deepseek.ps1 --model deepseek-v4-pro  # specify Pro
#   .\launch-deepseek.ps1 --model deepseek-v4-flash # specify Flash
#   $env:DEEPSEEK_VARIANT="flash"; .\launch-deepseek.ps1
#   $env:DEEPSEEK_MODEL="deepseek-v4-flash"; .\launch-deepseek.ps1
#
# API key sources (in order):
#   1. .env.deepseek with ANTHROPIC_AUTH_TOKEN
#   2. Shell env ANTHROPIC_AUTH_TOKEN
#   3. Windows Credential Manager: cmdkey /generic:deepseek_api_key /user:fexor /pass:YOUR_KEY
#
# To add a PowerShell alias:
#   Add to your $PROFILE:
#   Set-Alias fexor-deepseek "$env:USERPROFILE\Desktop\Github\fexor-code-main\windows\launch-deepseek.ps1"

$ErrorActionPreference = "Stop"

$env:CLAUDE_CONFIG_DIR = "$env:USERPROFILE\.fexor-code"
$ScriptDir = $PSScriptRoot

$defaultEffort   = if ($env:DEEPSEEK_EFFORT)   { $env:DEEPSEEK_EFFORT }   else { "max" }
$defaultThinking = if ($env:DEEPSEEK_THINKING) { $env:DEEPSEEK_THINKING } else { "adaptive" }
$DEEPSEEK_PRO_MODEL   = "deepseek-v4-pro"
$DEEPSEEK_FLASH_MODEL = "deepseek-v4-flash"

# ── Helpers ───────────────────────────────────────────────────────────────────
function Import-EnvFile([string]$Path) {
    if (-not (Test-Path $Path)) { return }
    Get-Content $Path | ForEach-Object {
        $line = $_.Trim()
        if ($line -match '^\s*#' -or $line -eq '') { return }
        if ($line -match '^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
            $key = $Matches[1]; $val = $Matches[2].Trim('"').Trim("'")
            if (-not [System.Environment]::GetEnvironmentVariable($key)) {
                Set-Item -Path "Env:$key" -Value $val
            }
        }
    }
}

function Get-WinCred([string]$Target) {
    $src = @'
using System; using System.Runtime.InteropServices; using System.Text;
namespace Fexor { public static class CredStore {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    private struct CREDENTIAL {
        public uint Flags, Type;
        [MarshalAs(UnmanagedType.LPWStr)] public string TargetName;
        [MarshalAs(UnmanagedType.LPWStr)] public string Comment;
        public long LastWritten; public uint CredentialBlobSize;
        public IntPtr CredentialBlob; public uint Persist, AttributeCount;
        public IntPtr Attributes;
        [MarshalAs(UnmanagedType.LPWStr)] public string TargetAlias;
        [MarshalAs(UnmanagedType.LPWStr)] public string UserName;
    }
    [DllImport("advapi32", SetLastError=true, CharSet=CharSet.Unicode)]
    private static extern bool CredRead(string t, uint tp, int f, out IntPtr c);
    [DllImport("advapi32")] private static extern void CredFree(IntPtr c);
    public static string Get(string target) {
        IntPtr ptr; if (!CredRead(target,1,0,out ptr)) return null;
        try { var c=Marshal.PtrToStructure<CREDENTIAL>(ptr);
              if (c.CredentialBlobSize==0) return "";
              var b=new byte[c.CredentialBlobSize];
              Marshal.Copy(c.CredentialBlob, b, 0, b.Length);
              return Encoding.Unicode.GetString(b); }
        finally { CredFree(ptr); }
    }
}}
'@
    if (-not ([System.Management.Automation.PSTypeName]'Fexor.CredStore').Type) {
        try { Add-Type -TypeDefinition $src -Language CSharp } catch {}
    }
    try { return [Fexor.CredStore]::Get($Target) } catch { return $null }
}

function Has-Arg([string]$Needle, [string[]]$ArgList) {
    foreach ($a in $ArgList) {
        if ($a -eq $Needle -or $a -like "$Needle=*") { return $true }
    }
    return $false
}

function Normalize-DeepSeekModel([string]$Model) {
    switch ($Model.ToLower()) {
        'pro'          { return $DEEPSEEK_PRO_MODEL }
        'v4-pro'       { return $DEEPSEEK_PRO_MODEL }
        'deepseek-pro' { return $DEEPSEEK_PRO_MODEL }
        'flash'        { return $DEEPSEEK_FLASH_MODEL }
        'v4-flash'     { return $DEEPSEEK_FLASH_MODEL }
        'deepseek-flash' { return $DEEPSEEK_FLASH_MODEL }
        default        { return $Model }
    }
}

function Get-DefaultDeepSeekModel {
    $deepseekVariantLower = if ($env:DEEPSEEK_VARIANT) { $env:DEEPSEEK_VARIANT.ToLower() } else { '' }
    switch ($deepseekVariantLower) {
        'flash'    { return $DEEPSEEK_FLASH_MODEL }
        'v4-flash' { return $DEEPSEEK_FLASH_MODEL }
        { $_ -in @('pro', 'v4-pro', '') } { return $DEEPSEEK_PRO_MODEL }
        default {
            Write-Host "[launch-deepseek] ERROR: DEEPSEEK_VARIANT must be 'pro' or 'flash'." -ForegroundColor Red
            exit 1
        }
    }
}

function Get-SelectedModel([string]$Default, [string[]]$ArgList) {
    $model = $Default
    for ($i = 0; $i -lt $ArgList.Count; $i++) {
        if ($ArgList[$i] -like '--model=*') { $model = $ArgList[$i].Substring(8) }
        elseif ($ArgList[$i] -eq '--model' -and $i + 1 -lt $ArgList.Count) { $model = $ArgList[$i + 1] }
    }
    return Normalize-DeepSeekModel $model
}

# ── Load API key (.env.deepseek → env) ───────────────────────────────────────
$envFile = Join-Path $ScriptDir ".env.deepseek"
Import-EnvFile $envFile

# Fall back to Windows Credential Manager if no token set
if (-not $env:ANTHROPIC_AUTH_TOKEN) {
    $env:ANTHROPIC_AUTH_TOKEN = Get-WinCred "deepseek_api_key"
}

# Hard override — ensures stale key in ~/.fexor-code cannot win
# (env var is already set at this point; re-exporting is a no-op in PS but is explicit)
if (-not $env:ANTHROPIC_AUTH_TOKEN) {
    Write-Host "[launch-deepseek] WARNING: ANTHROPIC_AUTH_TOKEN is not set." -ForegroundColor Yellow
    Write-Host "  Add it to Windows Credential Manager with:" -ForegroundColor Yellow
    Write-Host "    cmdkey /generic:deepseek_api_key /user:fexor /pass:YOUR_KEY" -ForegroundColor Cyan
    Write-Host "  Or create .env.deepseek with:" -ForegroundColor Yellow
    Write-Host "    ANTHROPIC_AUTH_TOKEN=YOUR_KEY" -ForegroundColor Cyan
}

# ── DeepSeek V4 — Anthropic-compatible endpoint ───────────────────────────────
$env:ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic"

$_dsBase = if ($env:DEEPSEEK_MODEL) { $env:DEEPSEEK_MODEL } else { Get-DefaultDeepSeekModel }
$defaultDeepSeekModel  = Normalize-DeepSeekModel $_dsBase
$selectedDeepSeekModel = Get-SelectedModel $defaultDeepSeekModel $args

$isFlash = $selectedDeepSeekModel -eq $DEEPSEEK_FLASH_MODEL

$env:ANTHROPIC_MODEL                            = $selectedDeepSeekModel
$env:ANTHROPIC_DEFAULT_OPUS_MODEL               = $DEEPSEEK_PRO_MODEL
$env:ANTHROPIC_DEFAULT_SONNET_MODEL             = $selectedDeepSeekModel
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL              = $DEEPSEEK_FLASH_MODEL
$env:ANTHROPIC_DEFAULT_OPUS_MODEL_NAME          = "DeepSeek V4-Pro"
$env:ANTHROPIC_DEFAULT_SONNET_MODEL_NAME        = if ($isFlash) { "DeepSeek V4-Flash" } else { "DeepSeek V4-Pro" }
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME         = "DeepSeek V4-Flash"
$env:ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION   = "DeepSeek V4-Pro via official Anthropic API - 1M context, max effort"
$env:ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION = if ($isFlash) { "DeepSeek V4-Flash via official Anthropic API - 1M context, max effort" } else { "DeepSeek V4-Pro via official Anthropic API - 1M context, max effort" }
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION  = "DeepSeek V4-Flash via official Anthropic API - 1M context, max effort"
$env:CLAUDE_CODE_SUBAGENT_MODEL = if ($env:DEEPSEEK_SUBAGENT_MODEL) { $env:DEEPSEEK_SUBAGENT_MODEL } else { $selectedDeepSeekModel }

# ── Thinking ──────────────────────────────────────────────────────────────────
$env:ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES   = "thinking,adaptive_thinking"
$env:ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES = "thinking,adaptive_thinking"
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES  = "thinking,adaptive_thinking"
$env:MAX_THINKING_TOKENS = "16000"

# ── Maximize the token window ─────────────────────────────────────────────────
$env:CLAUDE_CODE_MAX_CONTEXT_TOKENS = "1000000"
$env:CLAUDE_CODE_MAX_OUTPUT_TOKENS  = "64000"

# ── 3rd-party fidelity ────────────────────────────────────────────────────────
$env:CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS    = "1"
$env:DISABLE_INTERLEAVED_THINKING              = "1"
$env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC  = "1"
$env:CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK = "1"

# ── Lock /model picker ────────────────────────────────────────────────────────
$pythonScript = @"
import json, pathlib, sys
base = pathlib.Path(sys.argv[1]); base.mkdir(parents=True, exist_ok=True)
pro = sys.argv[2]; flash = sys.argv[3]
options = [
    {"value": pro,   "label": "DeepSeek V4-Pro",
     "description": "DeepSeek V4-Pro via official Anthropic API - 1M context, max effort",
     "descriptionForModel": "DeepSeek V4-Pro via official Anthropic API - 1M context, max effort"},
    {"value": flash, "label": "DeepSeek V4-Flash",
     "description": "DeepSeek V4-Flash via official Anthropic API - 1M context, max effort",
     "descriptionForModel": "DeepSeek V4-Flash via official Anthropic API - 1M context, max effort"},
]
cj = base / ".claude.json"
try: d = json.loads(cj.read_text())
except Exception: d = {}
d["additionalModelOptionsCache"] = options; cj.write_text(json.dumps(d, indent=2))
sj = base / "settings.json"
try: s = json.loads(sj.read_text())
except Exception: s = {}
s["availableModels"] = [pro, flash]; sj.write_text(json.dumps(s, indent=2))
"@

$_py3 = Get-Command python3 -ErrorAction SilentlyContinue
$_py  = Get-Command python  -ErrorAction SilentlyContinue
$pythonExe = if ($_py3) { $_py3.Source } elseif ($_py) { $_py.Source } else { $null }
if ($pythonExe) {
    try { & $pythonExe -c $pythonScript $env:CLAUDE_CONFIG_DIR $DEEPSEEK_PRO_MODEL $DEEPSEEK_FLASH_MODEL 2>$null } catch {}
}

# ── Build args and launch ─────────────────────────────────────────────────────
$launchArgs = [System.Collections.Generic.List[string]]::new()

if (-not (Has-Arg '--model' $args)) {
    $launchArgs.Add('--model'); $launchArgs.Add($selectedDeepSeekModel)
}
if (-not (Has-Arg '--effort' $args) -and -not $env:CLAUDE_CODE_EFFORT_LEVEL) {
    $launchArgs.Add('--effort'); $launchArgs.Add($defaultEffort)
}
if (-not (Has-Arg '--thinking' $args)) {
    $launchArgs.Add('--thinking'); $launchArgs.Add($defaultThinking)
}

$launchArgs.AddRange([string[]]$args)

$cliBin = Join-Path $ScriptDir "cli-dev.exe"
if (-not (Test-Path $cliBin)) { $cliBin = Join-Path $ScriptDir "cli-dev" }
& $cliBin @launchArgs
exit $LASTEXITCODE
