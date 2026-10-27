$ErrorActionPreference = 'Stop'
$evidence = 'E:\workspace\paperclip-member-agent-dev\doc\plans\2026-10-26-member-agent-integration-flake-evidence'
$runsDir = Join-Path $evidence 'baseline-runs'
New-Item -ItemType Directory -Force -Path $runsDir | Out-Null
$failures = [System.Collections.Generic.List[object]]::new()
$attempts = [System.Collections.Generic.List[object]]::new()
for ($i = 1; $i -le 30; $i++) {
  $name = 'run-{0:D2}.log' -f $i
  $logPath = Join-Path $runsDir $name
  $output = & pnpm exec vitest run --config vitest.config.ts test/codex-integration.test.ts --cache=false --reporter=verbose 2>&1
  $exitCode = $LASTEXITCODE
  $text = ($output | ForEach-Object { $_.ToString() }) -join "`n"
  [IO.File]::WriteAllText($logPath, $text + "`n", [Text.UTF8Encoding]::new($false))
  $passed = $exitCode -eq 0
  $attempt = [ordered]@{ number = $i; exitCode = $exitCode; passed = $passed; log = $name }
  $attempts.Add($attempt)
  if (-not $passed) {
    $startMarker = 'CODEX_INTEGRATION_DIAGNOSTIC_BEGIN'
    $endMarker = 'CODEX_INTEGRATION_DIAGNOSTIC_END'
    $start = $text.IndexOf($startMarker)
    $end = $text.IndexOf($endMarker)
    $diagnostic = $null
    if ($start -ge 0 -and $end -gt $start) {
      $json = $text.Substring($start + $startMarker.Length, $end - ($start + $startMarker.Length)).Trim()
      try { $diagnostic = $json | ConvertFrom-Json } catch { $diagnostic = @{ parseError = $_.Exception.Message; raw = $json } }
    }
    $failure = [ordered]@{ number = $i; exitCode = $exitCode; errorCode = $diagnostic.errorCode; errorMessage = $diagnostic.errorMessage; summary = $diagnostic.summary; recentJobLogs = $diagnostic.recentJobLogs; diagnosticFound = ($null -ne $diagnostic); log = $name }
    $failures.Add($failure)
  }
  Write-Output ('BASELINE_ATTEMPT {0:D2}/30 exit={1} passed={2}' -f $i, $exitCode, $passed)
}
$summary = [ordered]@{ startedAt = (Get-Date).ToUniversalTime().ToString('o'); total = $attempts.Count; passed = @($attempts | Where-Object passed).Count; failed = $failures.Count; attempts = $attempts; failures = $failures }
$summary | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $evidence 'baseline-30-summary.json') -Encoding utf8
Write-Output 'BASELINE_30_SUMMARY'
$summary | ConvertTo-Json -Depth 10