$ErrorActionPreference = 'Stop'
$memberRoot = 'E:\workspace\paperclip-member-agent-dev'
$settingsPath = 'E:\workspace\paperclip-member-agent-dev\doc\plans\2026-10-26-member-agent-b3-fix-evidence\b3-a521a7be\setup.json'
$settings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
$configPath = [string]$settings.configPath
if ([string]::IsNullOrWhiteSpace($configPath)) { throw 'B3_CONFIG_PATH_MISSING' }
try {
  $configFile = [IO.File]::Open($configPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
  $configFile.Dispose()
} catch {
  throw 'B3_CONFIG_NOT_READABLE'
}
Write-Host 'B3_CONFIG_PREFLIGHT_OK'
$secret = Read-Host '输入现有成员代理 API Key（不回显）' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
try {
  $env:PAPERCLIP_AGENT_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  Set-Location -LiteralPath $memberRoot
  Write-Host 'B3_FAKE_MODEL_MODE: no Codex account or auth.json is used; fake provider has requires_openai_auth=false'
  Write-Host 'B3_AGENT_RUN_START'
  & node .\member-agent\src\main.ts run --config $configPath
  exit $LASTEXITCODE
} finally {
  Remove-Item Env:PAPERCLIP_AGENT_KEY -ErrorAction SilentlyContinue
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  $secret.Dispose()
}
