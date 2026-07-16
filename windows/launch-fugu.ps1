#Requires -Version 5.1
# fexor-code Sakana Fugu launcher for Windows - OpenAI-compatible Responses endpoint.
#
# Usage:
#   .\launch-fugu.ps1
#   .\launch-fugu.ps1 -p "review this change"
#   $env:FUGU_MODEL="fugu-ultra"; .\launch-fugu.ps1 --model fugu-ultra
#
# Key sources, in order:
#   1. .env.fugu with SAKANA_API_KEY or FUGU_API_KEY
#   2. Shell env SAKANA_API_KEY or FUGU_API_KEY
#   3. Windows Credential Manager: cmdkey /generic:sakana_api_key /user:fexor /pass:YOUR_KEY
#                                   cmdkey /generic:fugu_api_key  /user:fexor /pass:YOUR_KEY

$ErrorActionPreference = "Stop"

$env:CLAUDE_CONFIG_DIR = "$env:USERPROFILE\.fexor-code-fugu"
$ScriptDir = $PSScriptRoot

# ── Defensive: clear provider env from parent shell ───────────────────────────
foreach ($v in @(
    'CLAUDE_CODE_USE_OPENAI','CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY',
    'ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','ANTHROPIC_CUSTOM_HEADERS',
    'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR','CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR','CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
    'ANTHROPIC_MODEL','ANTHROPIC_DEFAULT_OPUS_MODEL','ANTHROPIC_DEFAULT_SONNET_MODEL','ANTHROPIC_DEFAULT_HAIKU_MODEL'
)) { Remove-Item "Env:\$v" -ErrorAction SilentlyContinue }

$env:CLAUDE_CODE_USE_SAKANA_FUGU = "1"

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

function Get-SelectedModel([string]$Default, [string[]]$ArgList) {
    $model = $Default
    for ($i = 0; $i -lt $ArgList.Count; $i++) {
        if ($ArgList[$i] -like '--model=*') { $model = $ArgList[$i].Substring(8) }
        elseif ($ArgList[$i] -eq '--model' -and $i + 1 -lt $ArgList.Count) { $model = $ArgList[$i + 1] }
    }
    return $model
}

# ── Load API key ──────────────────────────────────────────────────────────────
$envFile = Join-Path $ScriptDir ".env.fugu"
Import-EnvFile $envFile

$apiKey = $env:SAKANA_API_KEY
if (-not $apiKey) { $apiKey = $env:FUGU_API_KEY }
if (-not $apiKey) { $apiKey = Get-WinCred "sakana_api_key" }
if (-not $apiKey) { $apiKey = Get-WinCred "fugu_api_key" }

if (-not $apiKey) {
    Write-Host "[launch-fugu] ERROR: Sakana API key not found." -ForegroundColor Red
    Write-Host "  Add it to Windows Credential Manager with:" -ForegroundColor Yellow
    Write-Host "    cmdkey /generic:sakana_api_key /user:fexor /pass:YOUR_KEY" -ForegroundColor Cyan
    Write-Host "  Or create gitignored .env.fugu with:" -ForegroundColor Yellow
    Write-Host "    SAKANA_API_KEY=YOUR_KEY" -ForegroundColor Cyan
    exit 1
}

$env:SAKANA_API_KEY = $apiKey
Remove-Item Env:\FUGU_API_KEY -ErrorAction SilentlyContinue
$apiKey = $null

# ── Model / endpoint config ───────────────────────────────────────────────────
$env:SAKANA_BASE_URL = if ($env:SAKANA_BASE_URL) { $env:SAKANA_BASE_URL } else { "https://api.sakana.ai/v1" }

$defaultFuguModel  = if ($env:FUGU_MODEL)       { $env:FUGU_MODEL }       else { "fugu" }
$selectedFuguModel = Get-SelectedModel $defaultFuguModel $args

$opusModel   = if ($env:FUGU_OPUS_MODEL)   { $env:FUGU_OPUS_MODEL }   else { "fugu-ultra" }
$sonnetModel = if ($env:FUGU_SONNET_MODEL) { $env:FUGU_SONNET_MODEL } else { "fugu" }
$haikusModel = if ($env:FUGU_HAIKU_MODEL)  { $env:FUGU_HAIKU_MODEL }  else { "fugu" }

$env:ANTHROPIC_MODEL                            = $selectedFuguModel
$env:ANTHROPIC_DEFAULT_OPUS_MODEL               = $opusModel
$env:ANTHROPIC_DEFAULT_SONNET_MODEL             = $sonnetModel
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL              = $haikusModel
$env:ANTHROPIC_DEFAULT_OPUS_MODEL_NAME          = if ($env:FUGU_OPUS_MODEL_NAME)   { $env:FUGU_OPUS_MODEL_NAME }   else { "Fugu Ultra" }
$env:ANTHROPIC_DEFAULT_SONNET_MODEL_NAME        = if ($env:FUGU_SONNET_MODEL_NAME) { $env:FUGU_SONNET_MODEL_NAME } else { "Fugu" }
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME         = if ($env:FUGU_HAIKU_MODEL_NAME)  { $env:FUGU_HAIKU_MODEL_NAME }  else { "Fugu" }
$env:ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION   = "Sakana Fugu Ultra via Responses API - 1M context"
$env:ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION = "Sakana Fugu via Responses API - 1M context"
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION  = "Sakana Fugu via Responses API - 1M context"
$env:CLAUDE_CODE_SUBAGENT_MODEL                 = if ($env:FUGU_SUBAGENT_MODEL) { $env:FUGU_SUBAGENT_MODEL } else { "fugu" }

# ── Token / timeout config ────────────────────────────────────────────────────
$env:API_TIMEOUT_MS                    = if ($env:API_TIMEOUT_MS)                    { $env:API_TIMEOUT_MS }                    else { "7200000" }
$env:CLAUDE_CODE_MAX_CONTEXT_TOKENS    = if ($env:CLAUDE_CODE_MAX_CONTEXT_TOKENS)    { $env:CLAUDE_CODE_MAX_CONTEXT_TOKENS }    else { "1000000" }
$env:CLAUDE_CODE_AUTO_COMPACT_WINDOW   = if ($env:CLAUDE_CODE_AUTO_COMPACT_WINDOW)   { $env:CLAUDE_CODE_AUTO_COMPACT_WINDOW }   else { "1000000" }
$maxOut = if ($env:FUGU_MAX_OUTPUT_TOKENS) { $env:FUGU_MAX_OUTPUT_TOKENS } else { "32000" }
$env:CLAUDE_CODE_MAX_OUTPUT_TOKENS     = if ($env:CLAUDE_CODE_MAX_OUTPUT_TOKENS)     { $env:CLAUDE_CODE_MAX_OUTPUT_TOKENS }     else { $maxOut }

# ── Fugu effort (high/xhigh/max; low/medium clamped to high by adapter) ───────
$env:CLAUDE_CODE_SAKANA_DEFAULT_EFFORT = if ($env:CLAUDE_CODE_SAKANA_DEFAULT_EFFORT) { $env:CLAUDE_CODE_SAKANA_DEFAULT_EFFORT } `
                                         elseif ($env:FUGU_EFFORT) { $env:FUGU_EFFORT } else { "high" }
$env:ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES   = "effort,max_effort"
$env:ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES = "effort,max_effort"
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES  = "effort,max_effort"

# ── Third-party fidelity ──────────────────────────────────────────────────────
$env:CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS    = if ($env:CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS) { $env:CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS } else { "1" }
$env:DISABLE_INTERLEAVED_THINKING              = if ($env:DISABLE_INTERLEAVED_THINKING)            { $env:DISABLE_INTERLEAVED_THINKING }            else { "1" }
$env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC  = "1"
$env:CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK = "1"

# ── Lock /model picker ────────────────────────────────────────────────────────
$pythonScript = @"
import json, pathlib, sys
base = pathlib.Path(sys.argv[1]); base.mkdir(parents=True, exist_ok=True)
default_model=sys.argv[2]; ultra_model=sys.argv[3]; selected_model=sys.argv[4]
options = [
    {"value":"fugu",       "label":"Fugu",
     "description":"Sakana Fugu via Responses API - 1M context",
     "descriptionForModel":"Sakana Fugu via Responses API - 1M context"},
    {"value":"fugu-ultra", "label":"Fugu Ultra",
     "description":"Sakana Fugu Ultra via Responses API - 1M context",
     "descriptionForModel":"Sakana Fugu Ultra via Responses API - 1M context"},
]
cj = base / ".claude.json"
try: d = json.loads(cj.read_text())
except Exception: d = {}
d["additionalModelOptionsCache"] = options; cj.write_text(json.dumps(d, indent=2))
sj = base / "settings.json"
try: s = json.loads(sj.read_text())
except Exception: s = {}
s["model"] = default_model
s["availableModels"] = sorted({"fugu","fugu-ultra",ultra_model,selected_model})
sj.write_text(json.dumps(s, indent=2))
"@

$_py3 = Get-Command python3 -ErrorAction SilentlyContinue
$_py  = Get-Command python  -ErrorAction SilentlyContinue
$pythonExe = if ($_py3) { $_py3.Source } elseif ($_py) { $_py.Source } else { $null }
if ($pythonExe) {
    try { & $pythonExe -c $pythonScript $env:CLAUDE_CONFIG_DIR $defaultFuguModel $opusModel $selectedFuguModel 2>$null } catch {}
}

# ── Build args and launch ─────────────────────────────────────────────────────
$launchArgs = [System.Collections.Generic.List[string]]::new()

if (-not (Has-Arg '--model' $args)) {
    $launchArgs.Add('--model'); $launchArgs.Add($selectedFuguModel)
}
if (-not (Has-Arg '--effort' $args) -and -not $env:CLAUDE_CODE_EFFORT_LEVEL) {
    $launchArgs.Add('--effort'); $launchArgs.Add($env:CLAUDE_CODE_SAKANA_DEFAULT_EFFORT)
}
# Note: --setting-sources "" (empty) is skipped on Windows — PS5.1 drops
# empty strings during array splatting. Isolated CLAUDE_CONFIG_DIR already
# prevents cross-launcher config bleed.

$launchArgs.AddRange([string[]]$args)

$cliBin = Join-Path $ScriptDir "cli-dev.exe"
if (-not (Test-Path $cliBin)) { $cliBin = Join-Path $ScriptDir "cli-dev" }
& $cliBin @launchArgs
exit $LASTEXITCODE
