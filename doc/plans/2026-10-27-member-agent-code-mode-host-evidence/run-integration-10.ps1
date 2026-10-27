$ErrorActionPreference='Stop'
$evidence='E:\workspace\paperclip-member-agent-dev\doc\plans\2026-10-27-member-agent-code-mode-host-evidence'
$runDir=Join-Path $evidence 'integration-10'
New-Item -ItemType Directory -Force -Path $runDir | Out-Null
$results=[Collections.Generic.List[object]]::new()
for($n=1;$n -le 10;$n++){
 $log=Join-Path $runDir ('run-{0:D2}.log' -f $n)
 pnpm exec vitest run --config vitest.config.ts test/codex-integration.test.ts --cache=false --reporter=verbose *> $log
 $code=$LASTEXITCODE
 Add-Content -LiteralPath $log -Value "EXIT_CODE=$code"
 $text=Get-Content -LiteralPath $log -Raw
 $roundtrip=$text.Contains('CODE_MODE_TOOL_ROUNDTRIP_OK fileNonceMatched=true toolOutputs=1 modelRequests=2')
 $passed=($code -eq 0 -and $roundtrip -and $text -match '2 passed')
 $results.Add([pscustomobject]@{run=$n;exitCode=$code;passed=$passed;realToolRoundtrip=$roundtrip;log=[IO.Path]::GetFileName($log)})
 [ordered]@{total=$results.Count;passed=@($results | Where-Object passed).Count;failed=@($results | Where-Object {-not $_.passed}).Count;testsPerRun=2;results=$results} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $evidence 'integration-10-summary.json') -Encoding utf8
 Write-Output ('INTEGRATION {0:D2}/10 exit={1} realToolRoundtrip={2}' -f $n,$code,$roundtrip)
}
if(@($results | Where-Object {-not $_.passed}).Count){exit 1}

