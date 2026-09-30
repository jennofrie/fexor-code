#Requires -Version 5.1
# fexor-code isolated launcher for Windows — DeepSeek V4.1 Flash / V4 Pro.
# Live API IDs: deepseek-flash, deepseek-v4-pro. Both effort max.
# Retired deepseek-v4-flash aliases are not used.
#
# Usage:
#   .\launch-deepseek.ps1                          # V4.1 Flash 1M, effort max
#   .\launch-deepseek.ps1 --model deepseek-v4-pro  # V4 Pro 1M, effort max
#   .\launch-deepseek.ps1 -p "explain this repo"
#   $env:DEEPSEEK_VARIANT="pro"; .\launch-deepseek.ps1
#
# API key sources (in order):
#   1. .env.deepseek with ANTHROPIC_AUTH_TOKEN
#   2. Shell env ANTHROPIC_AUTH_TOKEN
#   3. Windows Credential Manager: cmdkey /generic:deepseek_api_key /user:fexor /pass:YOUR_KEY

$ErrorActionPreference = "Stop"

$env:CLAUDE_CONFIG_DIR = "$env:USERPROFILE\.fexor-code"
$ScriptDir = $PSScriptRoot

$DEEPSEEK_FLASH_MAIN = "deepseek-flash[1m]"
$DEEPSEEK_FLASH_BARE = "deepseek-flash"
$DEEPSEEK_FLASH_NAME = "DeepSeek V4.1 Flash"
$DEEPSEEK_PRO_MAIN   = "deepseek-v4-pro[1m]"
$DEEPSEEK_PRO_NAME   = "DeepSeek V4 Pro"

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

function Get-SelectedFamily([string[]]$ArgList) {
    $raw = if ($env:DEEPSEEK_MODEL) { $env:DEEPSEEK_MODEL }
           elseif ($env:DEEPSEEK_VARIANT) { $env:DEEPSEEK_VARIANT }
           else { 'flash' }
    for ($i = 0; $i -lt $ArgList.Count; $i++) {
        if ($ArgList[$i] -like '--model=*') { $raw = $ArgList[$i].Substring(8) }
        elseif ($ArgList[$i] -eq '--model' -and $i + 1 -lt $ArgList.Count) { $raw = $ArgList[$i + 1] }
    }
    switch ($raw.ToLower()) {
        { $_ -in @('pro', 'deepseek-pro', 'deepseek-v4-pro', 'deepseek-v4-pro[1m]', 'v4-pro', 'v4.1-pro', 'v41-pro', 'deepseek-v4.1-pro') } { return 'pro' }
        default { return 'flash' }
    }
}

$envFile = Join-Path (Split-Path $ScriptDir -Parent) ".env.deepseek"
if (-not (Test-Path $envFile)) { $envFile = Join-Path $ScriptDir ".env.deepseek" }
Import-EnvFile $envFile

if (-not $env:ANTHROPIC_AUTH_TOKEN) {
    $env:ANTHROPIC_AUTH_TOKEN = Get-WinCred "deepseek_api_key"
}
if (-not $env:ANTHROPIC_AUTH_TOKEN) {
    Write-Host "[launch-deepseek] WARNING: ANTHROPIC_AUTH_TOKEN is not set." -ForegroundColor Yellow
    Write-Host "  Add it to Windows Credential Manager with:" -ForegroundColor Yellow
    Write-Host "    cmdkey /generic:deepseek_api_key /user:fexor /pass:YOUR_KEY" -ForegroundColor Cyan
    Write-Host "  Or create .env.deepseek with:" -ForegroundColor Yellow
    Write-Host "    ANTHROPIC_AUTH_TOKEN=YOUR_KEY" -ForegroundColor Cyan
}

$env:ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic"

$family = Get-SelectedFamily $args
if ($family -eq 'pro') {
    $selectedMain = $DEEPSEEK_PRO_MAIN
    $selectedName = $DEEPSEEK_PRO_NAME
} else {
    $selectedMain = $DEEPSEEK_FLASH_MAIN
    $selectedName = $DEEPSEEK_FLASH_NAME
}

$defaultThinking = if ($env:DEEPSEEK_THINKING) { $env:DEEPSEEK_THINKING } else { "enabled" }
$defaultEffort = "max"
if ($env:DEEPSEEK_EFFORT -and $env:DEEPSEEK_EFFORT.ToLower() -in @('high', 'medium', 'low')) {
    $defaultEffort = $env:DEEPSEEK_EFFORT.ToLower()
}

$env:ANTHROPIC_MODEL = $selectedMain
$env:ANTHROPIC_DEFAULT_OPUS_MODEL = $DEEPSEEK_PRO_MAIN
$env:ANTHROPIC_DEFAULT_SONNET_MODEL = $selectedMain
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL = $DEEPSEEK_FLASH_BARE
$env:ANTHROPIC_DEFAULT_OPUS_MODEL_NAME = $DEEPSEEK_PRO_NAME
$env:ANTHROPIC_DEFAULT_SONNET_MODEL_NAME = $selectedName
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME = $DEEPSEEK_FLASH_NAME
$env:ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION = "$DEEPSEEK_PRO_NAME via official API - 1M context, 384K max output, max effort"
$env:ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION = "$selectedName via official API - 1M context, 384K max output, max effort"
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION = "$DEEPSEEK_FLASH_NAME via official API - 1M context, 384K max output, max effort"
$env:CLAUDE_CODE_SUBAGENT_MODEL = if ($env:DEEPSEEK_SUBAGENT_MODEL) { $env:DEEPSEEK_SUBAGENT_MODEL } else { $DEEPSEEK_FLASH_BARE }

$env:ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES = "thinking,effort,max_effort"
$env:ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES = "thinking,effort,max_effort"
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES = "thinking,effort,max_effort"
$env:CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING = "1"
$env:MAX_THINKING_TOKENS = "16000"
$env:CLAUDE_CODE_MAX_CONTEXT_TOKENS = if ($env:CLAUDE_CODE_MAX_CONTEXT_TOKENS) { $env:CLAUDE_CODE_MAX_CONTEXT_TOKENS } else { "1000000" }
$env:CLAUDE_CODE_AUTO_COMPACT_WINDOW = if ($env:CLAUDE_CODE_AUTO_COMPACT_WINDOW) { $env:CLAUDE_CODE_AUTO_COMPACT_WINDOW } else { "786432" }
$env:CLAUDE_CODE_MAX_OUTPUT_TOKENS = if ($env:CLAUDE_CODE_MAX_OUTPUT_TOKENS) { $env:CLAUDE_CODE_MAX_OUTPUT_TOKENS } elseif ($env:DEEPSEEK_MAX_OUTPUT_TOKENS) { $env:DEEPSEEK_MAX_OUTPUT_TOKENS } else { "64000" }
$env:API_TIMEOUT_MS = if ($env:API_TIMEOUT_MS) { $env:API_TIMEOUT_MS } else { "3000000" }
$env:CLAUDE_CODE_AUTO_MODE_SERVER = if ($env:CLAUDE_CODE_AUTO_MODE_SERVER) { $env:CLAUDE_CODE_AUTO_MODE_SERVER } else { "0" }
$env:CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = "1"
$env:DISABLE_INTERLEAVED_THINKING = "1"
$env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1"
$env:CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK = "1"
if (-not $env:CLAUDE_CODE_EFFORT_LEVEL) { $env:CLAUDE_CODE_EFFORT_LEVEL = $defaultEffort }

$pythonScript = @"
import json, pathlib, sys
base = pathlib.Path(sys.argv[1]); base.mkdir(parents=True, exist_ok=True)
flash, flash_name, pro, pro_name = sys.argv[2:6]
options = [
    {"value": flash, "label": flash_name,
     "description": f"{flash_name} via official API - 1M context, 384K max output, max effort",
     "descriptionForModel": f"{flash_name} via official API - 1M context, 384K max output, max effort"},
    {"value": pro, "label": pro_name,
     "description": f"{pro_name} via official API - 1M context, 384K max output, max effort",
     "descriptionForModel": f"{pro_name} via official API - 1M context, 384K max output, max effort"},
]
cj = base / ".claude.json"
try: d = json.loads(cj.read_text())
except Exception: d = {}
d["additionalModelOptionsCache"] = options; cj.write_text(json.dumps(d, indent=2))
sj = base / "settings.json"
try: s = json.loads(sj.read_text())
except Exception: s = {}
s["availableModels"] = [flash, pro]; sj.write_text(json.dumps(s, indent=2))
"@

$_py3 = Get-Command python3 -ErrorAction SilentlyContinue
$_py  = Get-Command python  -ErrorAction SilentlyContinue
$pythonExe = if ($_py3) { $_py3.Source } elseif ($_py) { $_py.Source } else { $null }
if ($pythonExe) {
    try { & $pythonExe -c $pythonScript $env:CLAUDE_CONFIG_DIR $DEEPSEEK_FLASH_MAIN $DEEPSEEK_FLASH_NAME $DEEPSEEK_PRO_MAIN $DEEPSEEK_PRO_NAME 2>$null } catch {}
}

$launchArgs = [System.Collections.Generic.List[string]]::new()
if (-not (Has-Arg '--model' $args)) {
    $launchArgs.Add('--model'); $launchArgs.Add($selectedMain)
} else {
    for ($i = 0; $i -lt $args.Count; $i++) {
        if ($args[$i] -like '--model=*') { $args[$i] = "--model=$selectedMain" }
        elseif ($args[$i] -eq '--model' -and $i + 1 -lt $args.Count) { $args[$i + 1] = $selectedMain }
    }
}
if (-not (Has-Arg '--effort' $args)) {
    $launchArgs.Add('--effort'); $launchArgs.Add($env:CLAUDE_CODE_EFFORT_LEVEL)
}
if (-not (Has-Arg '--thinking' $args)) {
    $launchArgs.Add('--thinking'); $launchArgs.Add($defaultThinking)
}
$launchArgs.AddRange([string[]]$args)

$cliBin = Join-Path (Split-Path $ScriptDir -Parent) "cli-dev.exe"
if (-not (Test-Path $cliBin)) { $cliBin = Join-Path (Split-Path $ScriptDir -Parent) "cli-dev" }
if (-not (Test-Path $cliBin)) { $cliBin = Join-Path $ScriptDir "cli-dev.exe" }
if (-not (Test-Path $cliBin)) { $cliBin = Join-Path $ScriptDir "cli-dev" }
Write-Host "[launch-deepseek] model=$selectedMain  effort=$($env:CLAUDE_CODE_EFFORT_LEVEL)  thinking=$defaultThinking  compact=$($env:CLAUDE_CODE_AUTO_COMPACT_WINDOW)  out=$($env:CLAUDE_CODE_MAX_OUTPUT_TOKENS)"
& $cliBin @launchArgs
exit $LASTEXITCODE
