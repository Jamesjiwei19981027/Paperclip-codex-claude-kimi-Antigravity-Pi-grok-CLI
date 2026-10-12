$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent)).TrimEnd('\')
$repoPattern = [regex]::Escape($repo.Replace('\','/'))
try {
  $companies = Invoke-RestMethod 'http://127.0.0.1:3100/api/companies' -TimeoutSec 3
  foreach ($company in $companies) {
    $runs = Invoke-RestMethod "http://127.0.0.1:3100/api/companies/$($company.id)/heartbeat-runs?limit=100" -TimeoutSec 5
    $active = @($runs | ForEach-Object { $_ } | Where-Object { $_.status -in @('running','queued','scheduled_retry') })
    if ($active.Count -gt 0) { throw '仍有 Agent 任务运行或待重试，请先在后台结束任务再停止。' }
  }
} catch {
  if ($_.Exception.Message -like '*仍有 Agent*') { throw }
}
# Only this checkout's dev runner/watch wrappers, never general Node or CLI processes.
$targets = @(Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'node.exe' -and
  ($_.CommandLine.Replace('\','/') -match $repoPattern) -and
  ($_.CommandLine -match 'scripts[/\\]dev-runner\.ts|scripts[/\\]dev-watch\.ts')
})
# Stop this installation's embedded database gracefully before terminating wrappers.
$databaseDir = 'C:\Users\11580\.paperclip\instances\default\db'
$databasePattern = [regex]::Escape($databaseDir)
$database = @(Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'postgres.exe' -and $_.CommandLine -match "-D $databasePattern -p 54329"
})
$pgCtl = Join-Path $repo 'node_modules\.pnpm\@embedded-postgres+windows-x64@18.1.0-beta.16\node_modules\@embedded-postgres\windows-x64\native\bin\pg_ctl.exe'
if ($database.Count -eq 1 -and (Test-Path -LiteralPath $pgCtl)) {
  & $pgCtl -D $databaseDir stop -m fast -t 15
  if ($LASTEXITCODE -ne 0) { throw '数据库未能正常停止，保留服务进程以便检查。' }
}
foreach ($target in $targets) {
  $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($target.ProcessId)" -ErrorAction SilentlyContinue
  if ($current -and $current.CommandLine -eq $target.CommandLine) {
    & "$env:SystemRoot\System32\taskkill.exe" /PID $target.ProcessId /T /F | Out-Null
  }
}
Write-Output '已停止此仓库的开发服务进程树，数据库和公司数据保留。'
