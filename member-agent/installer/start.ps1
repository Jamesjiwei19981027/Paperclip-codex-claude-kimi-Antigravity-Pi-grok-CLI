param(
    [ValidateSet('run', 'check', 'login')][string]$Mode = 'run',
    [switch]$TestMode,
    [string]$InstallRoot,
    [string]$ConfigDir,
    [string]$TestExecutor,
    [string]$TestWait
)
$ErrorActionPreference = 'Stop'
function Assert-LauncherPath([string]$Path) {
    $cursor = [IO.Path]::GetFullPath($Path)
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) { $item = Get-Item -LiteralPath $cursor -Force; if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw '启动路径包含链接或重解析点。' } }
        $cursor = [IO.Path]::GetDirectoryName($cursor)
    }
}
function Write-LauncherLog([string]$Message) {
    $logDir = Join-Path $ConfigDir 'logs'; Assert-LauncherPath $logDir
    [void][IO.Directory]::CreateDirectory($logDir)
    foreach ($file in @(Get-ChildItem -LiteralPath $logDir -Filter 'launcher-????????.log' -File)) {
        Assert-LauncherPath $file.FullName
        if ($file.LastWriteTimeUtc -lt [DateTime]::UtcNow.AddDays(-7)) { Remove-Item -LiteralPath $file.FullName -Force }
    }
    $filePath = Join-Path $logDir ('launcher-' + (Get-Date -Format 'yyyyMMdd') + '.log'); Assert-LauncherPath $filePath
    [IO.File]::AppendAllText($filePath, ([DateTime]::UtcNow.ToString('o') + ' ' + $Message + [Environment]::NewLine), (New-Object Text.UTF8Encoding($false)))
}
$originalKey = $env:PAPERCLIP_AGENT_KEY
$exitCode = 1
try {
    if ($TestMode) {
        if (!$InstallRoot -or !$ConfigDir -or !$TestExecutor) { throw '测试模式必须显式指定 InstallRoot、ConfigDir 和 TestExecutor。' }
        $temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
        foreach ($p in @($InstallRoot, $ConfigDir, $TestExecutor) + @($TestWait | Where-Object { $_ })) {
            if (![IO.Path]::IsPathRooted($p) -or ![IO.Path]::GetFullPath($p).StartsWith($temp, [StringComparison]::OrdinalIgnoreCase)) { throw '测试模式只允许临时路径。' }
            Assert-LauncherPath $p
        }
        if ([IO.Path]::GetFullPath($InstallRoot).TrimEnd('\') -eq $temp.TrimEnd('\') -or [IO.Path]::GetFullPath($ConfigDir).TrimEnd('\') -eq $temp.TrimEnd('\')) { throw '禁止使用临时根目录。' }
    } else {
        if ($TestExecutor -or $TestWait) { throw '假执行器和等待器仅供测试模式使用。' }
        $defaultRoot = Join-Path $env:LOCALAPPDATA 'Programs\PaperclipMemberAgent'
        $defaultConfig = Join-Path $env:APPDATA 'paperclip-member-agent'
        if (($InstallRoot -and [IO.Path]::GetFullPath($InstallRoot) -ne $defaultRoot) -or ($ConfigDir -and [IO.Path]::GetFullPath($ConfigDir) -ne $defaultConfig)) { throw '自定义目录仅供测试模式使用。' }
        $InstallRoot = $defaultRoot; $ConfigDir = $defaultConfig
    }
    Assert-LauncherPath $InstallRoot; Assert-LauncherPath $ConfigDir
    $pointer = Join-Path $InstallRoot 'current.txt'; Assert-LauncherPath $pointer
    $version = (Get-Content -LiteralPath $pointer -Raw).Trim()
    if ($version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') { throw '当前版本记录无效，请重新运行安装脚本。' }
    $versionRoot = Join-Path (Join-Path $InstallRoot 'versions') $version; Assert-LauncherPath $versionRoot
    $configPath = Join-Path $ConfigDir 'config.json'; Assert-LauncherPath $configPath
    if ($Mode -ne 'login') {
        $keyPath = Join-Path $ConfigDir 'agent-key.dpapi'; Assert-LauncherPath $keyPath
        if ($TestMode) {
            if ((Get-Content -LiteralPath $keyPath -Raw).Trim() -ne 'FAKE-DPAPI-TEST-NOT-A-CREDENTIAL') { throw '测试模式仅接受明显的假 Key 标记。' }
            $env:PAPERCLIP_AGENT_KEY = 'FAKE-TEST-ENV-NOT-A-CREDENTIAL'
        } else {
            $secure = Get-Content -LiteralPath $keyPath -Raw | ConvertTo-SecureString
            $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
            try { $env:PAPERCLIP_AGENT_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
            finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr); $secure.Dispose(); $secure = $null; $bstr = [IntPtr]::Zero }
        }
    }
    $attempt = 0
    while ($true) {
        try {
            if ($TestMode) { $exitCode = [int](& $TestExecutor -Mode $Mode -ConfigPath $configPath -VersionRoot $versionRoot) }
            else {
                $node = Join-Path $versionRoot 'node\node.exe'; $main = Join-Path $versionRoot 'member-agent\src\main.ts'
                Assert-LauncherPath $node; Assert-LauncherPath $main
                & $node $main $Mode --config $configPath
                $exitCode = $LASTEXITCODE
                if ($null -eq $exitCode) { $exitCode = 1 }
            }
        } catch { $exitCode = 1; Write-LauncherLog '代理发生异常，准备按退出策略处理。' }
        Write-LauncherLog ('模式 ' + $Mode + '，退出码 ' + $exitCode)
        if ($Mode -ne 'run' -or @(0, 2, 3, 4, 5) -contains $exitCode) { break }
        $delays = @(10, 30, 60, 300); $delay = $delays[[Math]::Min($attempt, 3)]; $attempt++
        Write-LauncherLog ('将在 ' + $delay + ' 秒后重启。')
        if ($TestMode -and $TestWait) { & $TestWait -Seconds $delay -ConfigDir $ConfigDir }
        else { Start-Sleep -Seconds $delay }
    }
} catch {
    # Never echo exception values: a DPAPI/JSON/native error may contain input.
    Write-Error '启动失败。请检查当前版本、配置和加密 Key，必要时重新运行安装脚本。' -ErrorAction Continue
    $exitCode = 2
} finally { $env:PAPERCLIP_AGENT_KEY = $originalKey; $originalKey = $null }
exit $exitCode
