$ErrorActionPreference = 'Stop'
$evidence = 'E:\workspace\paperclip-member-agent-dev\doc\plans\2026-10-26-member-agent-integration-flake-evidence'
$runsDir = Join-Path $evidence 'post-fix-runs'
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
  $attempts.Add([ordered]@{ number = $i; exitCode = $exitCode; passed = $passed; log = $name })
  if (-not $passed) {
    $diag = $null
    foreach ($markers in @(@('CODEX_INTEGRATION_DIAGNOSTIC_BEGIN','CODEX_INTEGRATION_DIAGNOSTIC_END'),@('CODEX_INTEGRATION_CLEANUP_DIAGNOSTIC_BEGIN','CODEX_INTEGRATION_CLEANUP_DIAGNOSTIC_END'))) {
      $start = $text.IndexOf($markers[0]); $end = $text.IndexOf($markers[1])
      if ($start -ge 0 -and $end -gt $start) {
        $json = $text.Substring($start + $markers[0].Length, $end - ($start + $markers[0].Length)).Trim()
        try { $diag = $json | ConvertFrom-Json } catch { $diag = @{ parseError = $_.Exception.Message; raw = $json } }
        break
      }
    }
    $failure = [ordered]@{ number = $i; exitCode = $exitCode; jobErrorCode = $diag.jobResult.errorCode; jobErrorMessage = $diag.jobResult.errorMessage; cleanupErrorCode = $diag.cleanupError.code; cleanupErrorMessage = $diag.cleanupError.message; summary = $diag.jobResult.summary; recentJobLogs = $diag.jobResult.recentJobLogs; diagnostic = $diag; log = $name }
    $failures.Add($failure)
  }
  Write-Output ('POST_FIX_ATTEMPT {0:D2}/30 exit={1} passed={2}' -f $i, $exitCode, $passed)
}
$summary = [ordered]@{ startedAt = (Get-Date).ToUniversalTime().ToString('o'); total = $attempts.Count; passed = @($attempts | Where-Object passed).Count; failed = $failures.Count; attempts = $attempts; failures = $failures }
$summary | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $evidence 'post-fix-30-summary.json') -Encoding utf8
Write-Output 'POST_FIX_30_SUMMARY'
$summary | ConvertTo-Json -Depth 12