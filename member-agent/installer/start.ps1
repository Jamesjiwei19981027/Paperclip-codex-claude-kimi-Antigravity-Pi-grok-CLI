param(
    [ValidateSet('run', 'check', 'login')][string]$Mode = 'run',
    [switch]$TestMode,
    [string]$InstallRoot,
    [string]$ConfigDir,
    [string]$TestExecutor,
    [string]$TestWait,
    [ValidateSet('Manual', 'Scheduled')][string]$LaunchReason = 'Manual',
    [string]$TestLogonId
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
function Get-LauncherInputStamp([string]$Path) {
    Assert-LauncherPath $Path
    if (!(Test-Path -LiteralPath $Path -PathType Leaf)) { return 'missing' }
    $item = Get-Item -LiteralPath $Path -Force
    $stream = [IO.File]::OpenRead($Path); $hasher = [Security.Cryptography.SHA256]::Create()
    try { return ([string]$item.LastWriteTimeUtc.Ticks + ':' + [BitConverter]::ToString($hasher.ComputeHash($stream))) }
    finally { $stream.Dispose(); $hasher.Dispose() }
}
function Get-LauncherLogonId {
    # Some Windows tokens omit the logon SID from WindowsIdentity.Groups.
    $identity = & (Join-Path $env:SystemRoot 'System32\whoami.exe') /logonid
    if ($LASTEXITCODE -ne 0 -or ($identity -join '') -notmatch 'S-1-5-5-\d+-\d+') { throw '无法确认当前登录会话。' }
    return $Matches[0]
}
function Write-LauncherStop([int]$Code) {
    $record = @{ exitCode = $Code; logonId = $logonId; configStamp = $runConfigStamp; keyStamp = $runKeyStamp }
    $staging = $stopPath + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::WriteAllText($staging, ($record | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
        Move-Item -LiteralPath $staging -Destination $stopPath -Force
    } finally { if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Force } }
}
$originalKey = $env:PAPERCLIP_AGENT_KEY
$originalEncoding = [Console]::OutputEncoding
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
        if ($TestExecutor -or $TestWait -or $TestLogonId) { throw '假执行器、等待器和登录编号仅供测试模式使用。' }
        $defaultRoot = Join-Path $env:LOCALAPPDATA 'Programs\PaperclipMemberAgent'
        $defaultConfig = Join-Path $env:APPDATA 'paperclip-member-agent'
        if (($InstallRoot -and [IO.Path]::GetFullPath($InstallRoot) -ne $defaultRoot) -or ($ConfigDir -and [IO.Path]::GetFullPath($ConfigDir) -ne $defaultConfig)) { throw '自定义目录仅供测试模式使用。' }
        $InstallRoot = $defaultRoot; $ConfigDir = $defaultConfig
    }
    Assert-LauncherPath $InstallRoot; Assert-LauncherPath $ConfigDir
    $maintenance = Join-Path $InstallRoot 'maintenance.flag'; Assert-LauncherPath $maintenance
    if ($Mode -eq 'run' -and (Test-Path -LiteralPath $maintenance)) { Write-LauncherLog '安装维护中，本次不启动。'; exit 0 }
    $pointer = Join-Path $InstallRoot 'current.txt'; Assert-LauncherPath $pointer
    if ($LaunchReason -eq 'Scheduled' -and !(Test-Path -LiteralPath $pointer)) { Write-LauncherLog '安装已移除，本次不启动。'; exit 0 }
    $version = (Get-Content -LiteralPath $pointer -Raw).Trim()
    if ($version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') { throw '当前版本记录无效，请重新运行安装脚本。' }
    $versionRoot = Join-Path (Join-Path $InstallRoot 'versions') $version; Assert-LauncherPath $versionRoot
    $configPath = Join-Path $ConfigDir 'config.json'; Assert-LauncherPath $configPath
    $keyPath = Join-Path $ConfigDir 'agent-key.dpapi'; Assert-LauncherPath $keyPath
    # The logon SID is stable within one Windows sign-in and changes on the next.
    $logonId = if ($TestMode) { if ($TestLogonId) { $TestLogonId } else { 'test-session' } } else { Get-LauncherLogonId }
    $stopPath = Join-Path $ConfigDir 'launcher-stopped.json'; Assert-LauncherPath $stopPath
    if ($Mode -eq 'run' -and (Test-Path -LiteralPath $stopPath)) {
        $stopped = Get-Content -LiteralPath $stopPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $normalStop = $stopped.exitCode -eq 0 -and $LaunchReason -eq 'Scheduled' -and $stopped.logonId -eq $logonId
        $terminalStop = @(2, 3, 4, 5) -contains $stopped.exitCode -and $stopped.configStamp -eq (Get-LauncherInputStamp $configPath) -and $stopped.keyStamp -eq (Get-LauncherInputStamp $keyPath)
        if ($normalStop -or $terminalStop) { Write-LauncherLog '已停止且无需重试，本次不启动。'; exit 0 }
        Remove-Item -LiteralPath $stopPath -Force
    }
    $runConfigStamp = Get-LauncherInputStamp $configPath
    $runKeyStamp = Get-LauncherInputStamp $keyPath
    if ($Mode -ne 'login') {
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
        if ($Mode -eq 'run' -and (Test-Path -LiteralPath $maintenance)) { Write-LauncherLog '安装维护中，本次不启动。'; exit 0 }
        # Record the inputs used by this attempt, not edits made while it runs.
        $runConfigStamp = Get-LauncherInputStamp $configPath
        try {
            if ($TestMode) { $exitCode = [int](& $TestExecutor -Mode $Mode -ConfigPath $configPath -VersionRoot $versionRoot) }
            else {
                $node = Join-Path $versionRoot 'node\node.exe'; $main = Join-Path $versionRoot 'member-agent\src\main.ts'
                Assert-LauncherPath $node; Assert-LauncherPath $main
                $beforeNodeEncoding = [Console]::OutputEncoding
                try {
                    [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
                    & $node $main $Mode --config $configPath
                    $exitCode = $LASTEXITCODE
                } finally { [Console]::OutputEncoding = $beforeNodeEncoding }
                if ($null -eq $exitCode) { $exitCode = 1 }
            }
        } catch { $exitCode = 1; Write-LauncherLog '代理发生异常，准备按退出策略处理。' }
        Write-LauncherLog ('模式 ' + $Mode + '，退出码 ' + $exitCode)
        if ($Mode -ne 'run') { break }
        if (@(0, 2, 3, 4, 5) -contains $exitCode) { Write-LauncherStop $exitCode; break }
        $delays = @(10, 30, 60, 300); $delay = $delays[[Math]::Min($attempt, 3)]; $attempt++
        Write-LauncherLog ('将在 ' + $delay + ' 秒后重启。')
        if ($TestMode -and $TestWait) { & $TestWait -Seconds $delay -ConfigDir $ConfigDir }
        else { Start-Sleep -Seconds $delay }
    }
} catch {
    # Never echo exception values: a DPAPI/JSON/native error may contain input.
    Write-Error '启动失败。请检查当前版本、配置和加密 Key，必要时重新运行安装脚本。' -ErrorAction Continue
    $exitCode = 2
    if ($Mode -eq 'run' -and $stopPath) { try { Write-LauncherStop $exitCode } catch { } }
} finally { $env:PAPERCLIP_AGENT_KEY = $originalKey; $originalKey = $null; [Console]::OutputEncoding = $originalEncoding }
exit $exitCode
