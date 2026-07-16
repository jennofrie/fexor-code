#Requires -Version 5.1
# Store an API key in Windows Credential Manager.
# Equivalent to macOS: security add-generic-password -a "$USER" -s <service> -w 'KEY' -U
#
# Usage:
#   .\store-credential.ps1 -Service glm_api_key    -Password YOUR_GLM_KEY
#   .\store-credential.ps1 -Service zai_api_key    -Password YOUR_ZAI_KEY
#   .\store-credential.ps1 -Service sakana_api_key -Password YOUR_SAKANA_KEY
#   .\store-credential.ps1 -Service fugu_api_key   -Password YOUR_FUGU_KEY
#   .\store-credential.ps1 -Service deepseek_api_key -Password YOUR_DEEPSEEK_KEY
#
# To view stored credentials: rundll32.exe keymgr.dll,KRShowKeyMgr
# To remove a credential:     cmdkey /delete:glm_api_key

param(
    [Parameter(Mandatory=$true)]
    [string]$Service,

    [Parameter(Mandatory=$false)]
    [string]$Password
)

$ErrorActionPreference = "Stop"

if (-not $Password) {
    $secStr = Read-Host "Enter API key for '$Service'" -AsSecureString
    $Password = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secStr)
    )
}

# Store using cmdkey (built into all Windows versions)
$result = & cmdkey /generic:$Service /user:fexor /pass:$Password 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "[store-credential] ERROR: Failed to store credential '$Service'." -ForegroundColor Red
    Write-Host $result
    exit 1
}

Write-Host "[store-credential] Stored credential '$Service' in Windows Credential Manager." -ForegroundColor Green
Write-Host "  To verify: rundll32.exe keymgr.dll,KRShowKeyMgr" -ForegroundColor DarkGray
Write-Host "  To remove: cmdkey /delete:$Service" -ForegroundColor DarkGray
