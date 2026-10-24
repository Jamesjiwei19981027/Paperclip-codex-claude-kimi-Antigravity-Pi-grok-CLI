param([switch]$Foreground)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-common.ps1')
$repo = Split-Path $PSScriptRoot -Parent
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw '请用普通 PowerShell 启动，内嵌 PostgreSQL 不接受管理员运行。'
}
if ([string]::IsNullOrWhiteSpace($env:npm_config_script_shell)) {
  $env:npm_config_script_shell = Resolve-SetupGitBash
} elseif (!(Test-Path -LiteralPath $env:npm_config_script_shell -PathType Leaf)) {
  throw 'The explicit npm_config_script_shell does not exist.'
}
Set-Location -LiteralPath $repo
try {
  $health = Invoke-RestMethod 'http://127.0.0.1:3100/api/health' -TimeoutSec 3
  if ($health.status -eq 'ok') {
    Write-Output 'Paperclip 已运行：http://127.0.0.1:3100'
    return
  }
} catch { }
if ($Foreground) {
  pnpm dev
  if ($LASTEXITCODE -ne 0) { throw "pnpm dev 退出码：$LASTEXITCODE" }
  return
}
$logDir = Join-Path $repo '.paperclip\windows-logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$shell = (Get-Process -Id $PID).Path
$startArgs = '-NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -Foreground'
$process = Start-Process -FilePath $shell -ArgumentList $startArgs -WorkingDirectory $repo -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logDir 'stdout.log') -RedirectStandardError (Join-Path $logDir 'stderr.log')
Write-Output "已后台启动（PID $($process.Id)），日志：$logDir"
Write-Output '首次构建后打开：http://127.0.0.1:3100'
