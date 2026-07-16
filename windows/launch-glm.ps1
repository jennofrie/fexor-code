#Requires -Version 5.1
# fexor-code GLM launcher for Windows - Z.AI Anthropic Messages endpoint.
#
# Usage:
#   .\launch-glm.ps1
#   .\launch-glm.ps1 -p "review this change"
#   $env:GLM_MODEL="glm-5.2"; .\launch-glm.ps1 --model glm-5.2
#   $env:GLM_MAX_OUTPUT_TOKENS=128000; .\launch-glm.ps1
#
# Key sources, in order:
#   1. .env.glm with GLM_API_KEY, ZAI_API_KEY, or Z_AI_API_KEY
#   2. Shell env GLM_API_KEY, ZAI_API_KEY, or Z_AI_API_KEY
#   3. Windows Credential Manager: cmdkey /generic:glm_api_key /user:fexor /pass:YOUR_KEY
#                                   cmdkey /generic:zai_api_key /user:fexor /pass:YOUR_KEY

$ErrorActionPreference = "Stop"

$env:CLAUDE_CONFIG_DIR = "$env:USERPROFILE\.fexor-code-glm"
$ScriptDir = $PSScriptRoot

# ── Defensive: clear provider env from parent shell ───────────────────────────
foreach ($v in @(
    'CLAUDE_CODE_USE_OPENAI','CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY',
    'ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','ANTHROPIC_CUSTOM_HEADERS',
    'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR','CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR','CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
    'ANTHROPIC_MODEL','ANTHROPIC_DEFAULT_OPUS_MODEL','ANTHROPIC_DEFAULT_SONNET_MODEL','ANTHROPIC_DEFAULT_HAIKU_MODEL'
)) { Remove-Item "Env:\$v" -ErrorAction SilentlyContinue }

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

function Get-ExistingGlmSessions {
    try {
        Get-WmiObject Win32_Process -Filter "Name='cli-dev.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -match '--model(=| )glm-' }
    } catch { $null }
}

# ── Concurrent-session guard ──────────────────────────────────────────────────
if (($env:GLM_ALLOW_CONCURRENT -ne '1')) {
    $existing = Get-ExistingGlmSessions
    if ($existing) {
        Write-Error "[launch-glm] ERROR: another GLM fexor-code session is already running."
        Write-Host "  Stop that session first, or relaunch with `$env:GLM_ALLOW_CONCURRENT=1 if you intentionally want parallel GLM sessions." -ForegroundColor Yellow
        Write-Host $existing
        exit 1
    }
}

# ── Load API key ──────────────────────────────────────────────────────────────
$envFile = Join-Path $ScriptDir ".env.glm"
Import-EnvFile $envFile

$apiKey = $env:GLM_API_KEY
if (-not $apiKey) { $apiKey = $env:ZAI_API_KEY }
if (-not $apiKey) { $apiKey = $env:Z_AI_API_KEY }
if (-not $apiKey) { $apiKey = Get-WinCred "glm_api_key" }
if (-not $apiKey) { $apiKey = Get-WinCred "zai_api_key" }

if (-not $apiKey) {
    Write-Host "[launch-glm] ERROR: GLM/Z.AI API key not found." -ForegroundColor Red
    Write-Host "  Add it to Windows Credential Manager with:" -ForegroundColor Yellow
    Write-Host "    cmdkey /generic:glm_api_key /user:fexor /pass:YOUR_KEY" -ForegroundColor Cyan
    Write-Host "  Or create gitignored .env.glm with:" -ForegroundColor Yellow
    Write-Host "    GLM_API_KEY=YOUR_KEY" -ForegroundColor Cyan
    exit 1
}

$env:ANTHROPIC_API_KEY   = $apiKey
$env:ANTHROPIC_AUTH_TOKEN = $apiKey
Remove-Item Env:\GLM_API_KEY  -ErrorAction SilentlyContinue
Remove-Item Env:\ZAI_API_KEY  -ErrorAction SilentlyContinue
Remove-Item Env:\Z_AI_API_KEY -ErrorAction SilentlyContinue
$apiKey = $null

# ── Model / endpoint config ───────────────────────────────────────────────────
$env:ANTHROPIC_BASE_URL = if ($env:GLM_BASE_URL) { $env:GLM_BASE_URL } else { "https://api.z.ai/api/anthropic" }

$defaultGlmModel = if ($env:GLM_MODEL) { $env:GLM_MODEL } else { "glm-5.2[1m]" }
$selectedGlmModel = Get-SelectedModel $defaultGlmModel $args
$glmLabel = "GLM-5.2"
$glmDesc  = "Z.AI GLM-5.2 via Anthropic API - 1M context, max effort"

$env:ANTHROPIC_MODEL                      = $selectedGlmModel
$env:ANTHROPIC_DEFAULT_OPUS_MODEL         = $defaultGlmModel
$env:ANTHROPIC_DEFAULT_SONNET_MODEL       = $defaultGlmModel
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL        = if ($env:GLM_HAIKU_MODEL) { $env:GLM_HAIKU_MODEL } else { "glm-4.5-air" }
$env:ANTHROPIC_DEFAULT_OPUS_MODEL_NAME    = "$glmLabel (1M context)"
$env:ANTHROPIC_DEFAULT_SONNET_MODEL_NAME  = "$glmLabel (1M context)"
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME   = $env:ANTHROPIC_DEFAULT_HAIKU_MODEL
$env:ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION   = $glmDesc
$env:ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION = $glmDesc
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION  = "Z.AI $($env:ANTHROPIC_DEFAULT_HAIKU_MODEL) via Anthropic API"
$env:CLAUDE_CODE_SUBAGENT_MODEL = if ($env:GLM_SUBAGENT_MODEL) { $env:GLM_SUBAGENT_MODEL } else { $env:ANTHROPIC_DEFAULT_HAIKU_MODEL }

# ── Token / timeout config ────────────────────────────────────────────────────
$env:API_TIMEOUT_MS                    = if ($env:API_TIMEOUT_MS)                    { $env:API_TIMEOUT_MS }                    else { "3000000" }
$env:CLAUDE_CODE_MAX_CONTEXT_TOKENS    = if ($env:CLAUDE_CODE_MAX_CONTEXT_TOKENS)    { $env:CLAUDE_CODE_MAX_CONTEXT_TOKENS }    else { "1000000" }
$env:CLAUDE_CODE_AUTO_COMPACT_WINDOW   = if ($env:CLAUDE_CODE_AUTO_COMPACT_WINDOW)   { $env:CLAUDE_CODE_AUTO_COMPACT_WINDOW }   else { "1000000" }
$maxOut = if ($env:GLM_MAX_OUTPUT_TOKENS) { $env:GLM_MAX_OUTPUT_TOKENS } else { "32000" }
$env:CLAUDE_CODE_MAX_OUTPUT_TOKENS     = if ($env:CLAUDE_CODE_MAX_OUTPUT_TOKENS)     { $env:CLAUDE_CODE_MAX_OUTPUT_TOKENS }     else { $maxOut }

# ── Reasoning / capabilities ──────────────────────────────────────────────────
$env:ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES   = "thinking,effort,max_effort"
$env:ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES = "thinking,effort,max_effort"
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES  = "thinking,effort"
$env:MAX_THINKING_TOKENS = if ($env:MAX_THINKING_TOKENS) { $env:MAX_THINKING_TOKENS } else { "16000" }

# ── Third-party fidelity ──────────────────────────────────────────────────────
$env:CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS    = if ($env:CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS)    { $env:CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS }    else { "1" }
$env:DISABLE_INTERLEAVED_THINKING              = if ($env:DISABLE_INTERLEAVED_THINKING)              { $env:DISABLE_INTERLEAVED_THINKING }              else { "1" }
$env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC  = "1"
$env:CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK = "1"

# ── Rate-limit / unattended retry ─────────────────────────────────────────────
$env:CLAUDE_CODE_UNATTENDED_RETRY = if ($env:CLAUDE_CODE_UNATTENDED_RETRY) { $env:CLAUDE_CODE_UNATTENDED_RETRY } else { "1" }

# ── Lock /model picker (uses Python to write isolated config) ─────────────────
$pythonScript = @"
import json, pathlib, sys
base = pathlib.Path(sys.argv[1]); base.mkdir(parents=True, exist_ok=True)
glm = sys.argv[2]; haiku = sys.argv[3]
options = [
    {"value": glm,   "label": "GLM-5.2 (1M context)",
     "description": "Z.AI GLM-5.2 via Anthropic API - 1M context, max effort",
     "descriptionForModel": "Z.AI GLM-5.2 via Anthropic API - 1M context, max effort"},
    {"value": haiku, "label": haiku,
     "description": f"Z.AI {haiku} via Anthropic API",
     "descriptionForModel": f"Z.AI {haiku} via Anthropic API"},
]
cj = base / ".claude.json"
try: d = json.loads(cj.read_text())
except Exception: d = {}
d["additionalModelOptionsCache"] = options; cj.write_text(json.dumps(d, indent=2))
sj = base / "settings.json"
try: s = json.loads(sj.read_text())
except Exception: s = {}
s["model"] = glm; s["availableModels"] = [glm, haiku]; sj.write_text(json.dumps(s, indent=2))
"@

$_py3 = Get-Command python3 -ErrorAction SilentlyContinue
$_py  = Get-Command python  -ErrorAction SilentlyContinue
$pythonExe = if ($_py3) { $_py3.Source } elseif ($_py) { $_py.Source } else { $null }
if ($pythonExe) {
    try {
        & $pythonExe -c $pythonScript $env:CLAUDE_CONFIG_DIR $defaultGlmModel $env:ANTHROPIC_DEFAULT_HAIKU_MODEL 2>$null
    } catch {}
}

# ── Autonomy prompt (optional addendum) ──────────────────────────────────────
$defaultPromptFile = if ($env:GLM_AUTONOMY_PROMPT_FILE) { $env:GLM_AUTONOMY_PROMPT_FILE } `
                     else { Join-Path $ScriptDir "prompts\glm-autonomy-system-prompt.md" }

# ── Build args and launch ─────────────────────────────────────────────────────
$launchArgs = [System.Collections.Generic.List[string]]::new()

if (-not (Has-Arg '--model' $args)) {
    $launchArgs.Add('--model'); $launchArgs.Add($selectedGlmModel)
}
if (-not (Has-Arg '--effort' $args) -and -not $env:CLAUDE_CODE_EFFORT_LEVEL) {
    $launchArgs.Add('--effort')
    $glmEffort = if ($env:GLM_EFFORT) { $env:GLM_EFFORT } else { 'max' }
    $launchArgs.Add($glmEffort)
}
if (-not (Has-Arg '--thinking' $args) -and $env:GLM_THINKING) {
    $launchArgs.Add('--thinking'); $launchArgs.Add($env:GLM_THINKING)
}
$glmAutonomyEnabled = ($env:GLM_AUTONOMY_PROMPT -ne '0') -and ($env:GLM_DISABLE_AUTONOMY_PROMPT -ne '1')
if ($glmAutonomyEnabled -and
    (-not (Has-Arg '--append-system-prompt' $args)) -and
    (-not (Has-Arg '--append-system-prompt-file' $args)) -and
    (Test-Path $defaultPromptFile)) {
    $launchArgs.Add('--append-system-prompt-file'); $launchArgs.Add($defaultPromptFile)
}
# Note: --setting-sources "" (empty) is skipped on Windows — PS5.1 drops
# empty strings during array splatting. Isolated CLAUDE_CONFIG_DIR already
# prevents cross-launcher config bleed.

$launchArgs.AddRange([string[]]$args)

$cliBin = Join-Path $ScriptDir "cli-dev.exe"
if (-not (Test-Path $cliBin)) { $cliBin = Join-Path $ScriptDir "cli-dev" }
& $cliBin @launchArgs
exit $LASTEXITCODE
