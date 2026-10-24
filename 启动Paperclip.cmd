@echo off
setlocal
title Paperclip
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0company-setup\start-paperclip.ps1"
if errorlevel 1 goto failed
echo Waiting for Paperclip...
powershell.exe -NoProfile -Command "$deadline = (Get-Date).AddMinutes(3); do { try { $health = Invoke-RestMethod 'http://127.0.0.1:3100/api/health' -TimeoutSec 3; if ($health.status -eq 'ok') { Start-Process 'http://127.0.0.1:3100'; exit 0 } } catch { }; Start-Sleep -Seconds 2 } while ((Get-Date) -lt $deadline); Write-Host 'Startup timed out. Logs: .paperclip\windows-logs (in the checkout)'; exit 1"
if errorlevel 1 goto failed
exit /b 0
:failed
echo Paperclip startup failed. See the message above.
pause
exit /b 1
