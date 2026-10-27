$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent)).TrimEnd('\')
$repoPattern = [regex]::Escape($repo.Replace('\', '/')) + '(?:/|["\s])'

function Resolve-InstancePath([string]$Value) {
  if ($Value -eq '~') { $Value = $env:USERPROFILE }
  elseif ($Value.StartsWith('~/') -or $Value.StartsWith('~\')) {
    $Value = Join-Path $env:USERPROFILE $Value.Substring(2)
  }
  if (![IO.Path]::IsPathRooted($Value)) { $Value = Join-Path $repo $Value }
  return [IO.Path]::GetFullPath($Value)
}

$paperclipHome = if ([string]::IsNullOrWhiteSpace($env:PAPERCLIP_HOME)) {
  Join-Path ([Environment]::GetFolderPath('UserProfile')) '.paperclip'
} else { Resolve-InstancePath $env:PAPERCLIP_HOME }
$instanceId = if ([string]::IsNullOrWhiteSpace($env:PAPERCLIP_INSTANCE_ID)) { 'default' } else { $env:PAPERCLIP_INSTANCE_ID.Trim() }
if ($instanceId -notmatch '^[a-zA-Z0-9_-]+$') { throw 'Invalid PAPERCLIP_INSTANCE_ID.' }
$instanceRoot = Join-Path (Join-Path $paperclipHome 'instances') $instanceId
$configPath = if (![string]::IsNullOrWhiteSpace($env:PAPERCLIP_CONFIG)) {
  Resolve-InstancePath $env:PAPERCLIP_CONFIG
} elseif (Test-Path -LiteralPath (Join-Path $repo '.paperclip\config.json') -PathType Leaf) {
  Join-Path $repo '.paperclip\config.json'
} else { Join-Path $instanceRoot 'config.json' }
$databaseDir = Join-Path $instanceRoot 'db'
$databaseMode = 'embedded-postgres'
if (Test-Path -LiteralPath $configPath -PathType Leaf) {
  $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
  if ($config.database.mode) { $databaseMode = $config.database.mode }
  if ($config.database.embeddedPostgresDataDir) {
    $databaseDir = Resolve-InstancePath $config.database.embeddedPostgresDataDir
  }
}

# Only this checkout's dev runner/watch wrappers, never general Node or CLI processes.
$processes = @(Get-CimInstance Win32_Process)
$targets = @($processes | Where-Object {
  $_.Name -eq 'node.exe' -and $_.CommandLine -and
  ($_.CommandLine.Replace('\', '/') -match $repoPattern) -and
  ($_.CommandLine -match 'scripts[/\\]dev-runner\.ts|scripts[/\\]dev-watch\.ts')
})
if ($targets.Count -eq 0) {
  Write-Output 'No verified development runner belongs to this checkout; no processes were stopped.'
  return
}

# A failed API check is not proof that agents are idle. Leave all processes intact.
try {
  $companies = Invoke-RestMethod 'http://127.0.0.1:3100/api/companies' -TimeoutSec 3
  foreach ($company in $companies) {
    $runs = Invoke-RestMethod "http://127.0.0.1:3100/api/companies/$($company.id)/heartbeat-runs?limit=100" -TimeoutSec 5
    $active = @($runs | ForEach-Object { $_ } | Where-Object { $_.status -in @('running', 'queued', 'scheduled_retry') })
    if ($active.Count -gt 0) { throw 'Agent tasks are running or awaiting retry. End them in Paperclip before stopping.' }
  }
} catch {
  throw 'Could not verify that all agent tasks are idle; no service processes were stopped.'
}

# Match the exact data directory and use pg_ctl from that postgres installation.
# A missing identity or matching control executable keeps the service running.
if ($databaseMode -in @('embedded-postgres', 'pglite') -and [string]::IsNullOrWhiteSpace($env:DATABASE_URL)) {
  $databasePattern = [regex]::Escape(([IO.Path]::GetFullPath($databaseDir)).Replace('\', '/'))
  $database = @($processes | Where-Object {
    $_.Name -eq 'postgres.exe' -and $_.CommandLine -and
    $_.CommandLine.Replace('\', '/') -match ('(?:^|\s)-D\s+(?:"' + $databasePattern + '"|' + $databasePattern + ')(?=\s|$)')
  })
  if ($database.Count -ne 1 -or !$database[0].ExecutablePath) {
    throw 'Could not verify one embedded PostgreSQL process for this instance; service processes were preserved.'
  }
  $currentDatabase = Get-CimInstance Win32_Process -Filter "ProcessId=$($database[0].ProcessId)"
  if (!$currentDatabase -or $currentDatabase.CommandLine -ne $database[0].CommandLine -or
      $currentDatabase.ExecutablePath -ne $database[0].ExecutablePath -or
      $currentDatabase.CreationDate -ne $database[0].CreationDate) {
    throw 'The embedded PostgreSQL process identity changed; service processes were preserved.'
  }
  $pgCtl = Join-Path (Split-Path $database[0].ExecutablePath -Parent) 'pg_ctl.exe'
  if (!(Test-Path -LiteralPath $pgCtl -PathType Leaf)) {
    throw 'The matching PostgreSQL pg_ctl executable was not found; service processes were preserved.'
  }
  & $pgCtl -D $databaseDir stop -m fast -t 15
  if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL did not stop normally; service processes were preserved for inspection.' }
}
foreach ($target in $targets) {
  $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($target.ProcessId)" -ErrorAction SilentlyContinue
  if ($current -and $current.CommandLine -eq $target.CommandLine -and $current.CreationDate -eq $target.CreationDate) {
    & "$env:SystemRoot\System32\taskkill.exe" /PID $target.ProcessId /T /F | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'A verified development process tree could not be stopped.' }
  }
}
Write-Output 'Stopped the verified development service trees for this checkout. Instance data was preserved.'
