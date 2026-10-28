param(
    [switch]$TestMode,
    [string]$InstallRoot,
    [string]$ConfigDir,
    [switch]$RemoveConfig,
    [switch]$RemoveHome,
    [switch]$RemoveLogs,
    [switch]$Library
)
$ErrorActionPreference = 'Stop'

# Shared by install.ps1. Library mode defines functions and performs no I/O.
function Assert-PlainPath([string]$Path) {
    $full = [IO.Path]::GetFullPath($Path)
    $cursor = $full
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw '拒绝链接或重解析点路径。请使用普通目录。' }
        }
        $parent = [IO.Path]::GetDirectoryName($cursor)
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
    return $full
}
function Get-PlainTree([string]$Path) {
    [void](Assert-PlainPath $Path)
    if (!(Test-Path -LiteralPath $Path)) { return }
    foreach ($item in @(Get-ChildItem -LiteralPath $Path -Force)) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw '目录中有链接或重解析点，已停止操作。' }
        $item
        if ($item.PSIsContainer) { Get-PlainTree $item.FullName }
    }
}
function Resolve-MemberPaths([bool]$Testing, [string]$RootPath, [string]$ConfigPath) {
    if ($Testing) {
        if (!$RootPath -or !$ConfigPath -or ![IO.Path]::IsPathRooted($RootPath) -or ![IO.Path]::IsPathRooted($ConfigPath)) { throw '测试模式必须显式指定临时 InstallRoot 和 ConfigDir。' }
        $temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
        foreach ($candidate in @($RootPath, $ConfigPath)) {
            $full = [IO.Path]::GetFullPath($candidate)
            if (!$full.StartsWith($temp, [StringComparison]::OrdinalIgnoreCase) -or $full.TrimEnd('\') -eq $temp.TrimEnd('\')) { throw '测试模式只允许临时目录中的专用子目录。' }
        }
    } else {
        $defaultRoot = Join-Path $env:LOCALAPPDATA 'Programs\PaperclipMemberAgent'
        $defaultConfig = Join-Path $env:APPDATA 'paperclip-member-agent'
        if (($RootPath -and [IO.Path]::GetFullPath($RootPath) -ne $defaultRoot) -or ($ConfigPath -and [IO.Path]::GetFullPath($ConfigPath) -ne $defaultConfig)) { throw '自定义目录仅限显式测试模式。' }
        $RootPath = $defaultRoot; $ConfigPath = $defaultConfig
    }
    $r = Assert-PlainPath $RootPath; $c = Assert-PlainPath $ConfigPath
    if ($r -eq $c -or $r.StartsWith($c.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or $c.StartsWith($r.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '程序目录和用户数据目录必须独立。' }
    return @{ Root = $r; Config = $c }
}
function Remove-PlainTree([string]$Path) {
    [void](Assert-PlainPath $Path)
    if (Test-Path -LiteralPath $Path) { [void]@(Get-PlainTree $Path); Remove-Item -LiteralPath $Path -Recurse -Force }
}
function Confirm-Member([string]$Question, [bool]$Testing, [bool]$TestAnswer = $false, [switch]$DefaultYes) {
    if ($Testing) { return $TestAnswer }
    if ($DefaultYes) {
        $answer = Read-Host ($Question + ' [Y/n]')
        return [string]::IsNullOrWhiteSpace($answer) -or $answer -match '^(y|yes|是)$'
    }
    return (Read-Host ($Question + ' [y/N]')) -match '^(y|yes|是)$'
}
function Write-MemberText([string]$Path, [string]$Text) {
    [void](Assert-PlainPath $Path)
    $staging = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    try { [IO.File]::WriteAllText($staging, $Text, (New-Object Text.UTF8Encoding($false))); Move-Item -LiteralPath $staging -Destination $Path -Force }
    finally { if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Force } }
}
function Read-MemberJson([string]$Path) {
    $text = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    # PowerShell 7 otherwise converts ISO timestamps to DateTime and rewrites
    # their spelling when the identity is sent back to the running agent.
    $convert = Get-Command ConvertFrom-Json
    if ($convert.Parameters.ContainsKey('DateKind')) { return ConvertFrom-Json -InputObject $text -DateKind String }
    return ConvertFrom-Json -InputObject $text
}
function Set-MemberAcl($Item, $Acl) {
    # Set-Acl also rewrites the SACL on a protected path and needs SeSecurityPrivilege.
    if ($Item.PSObject.Methods.Name -contains 'SetAccessControl') { $Item.SetAccessControl($Acl) }
    else { [IO.FileSystemAclExtensions]::SetAccessControl($Item, $Acl) }
}
function Protect-MemberPath([string]$Path, [bool]$Directory = $false) {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    if ($Directory) {
        $acl = New-Object Security.AccessControl.DirectorySecurity
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    } else {
        $acl = New-Object Security.AccessControl.FileSecurity
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')
    }
    $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true, $false); $acl.AddAccessRule($rule)
    Set-MemberAcl (Get-Item -LiteralPath $Path -Force) $acl
}
function Get-OwnedAgent($Identity, [string]$RootPath, [string]$ConfigPath) {
    if (!$Identity -or !$Identity.pid -or !$Identity.startedAt) { return $null }
    $agentPid = 0
    if (![int]::TryParse([string]$Identity.pid, [ref]$agentPid) -or $agentPid -le 0) { return $null }
    $process = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $agentPid) -ErrorAction SilentlyContinue
    if (!$process -or !$process.ExecutablePath -or !$process.CommandLine -or !$process.CreationDate) { return $null }
    $exe = [IO.Path]::GetFullPath($process.ExecutablePath)
    $prefix = (Join-Path $RootPath 'versions').TrimEnd('\') + '\'
    if (!$exe.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($exe) -ne 'node.exe') { return $null }
    # Both absolute code and config arguments must refer to this installation.
    if (!$process.CommandLine.Contains((Join-Path $RootPath 'versions')) -or !$process.CommandLine.Contains((Join-Path $ConfigPath 'config.json')) -or $process.CommandLine -notmatch 'main\.ts[" ]+run(?:\s|$)') { return $null }
    $claimed = [DateTime]::Parse([string]$Identity.startedAt).ToUniversalTime()
    # Runtime startedAt is process creation time, never wall time at lock acquisition.
    if ([Math]::Abs(($process.CreationDate.ToUniversalTime() - $claimed).TotalMilliseconds) -gt 1000) { return $null }
    return $process
}
function Stop-MemberAgent([string]$RootPath, [string]$ConfigPath, [bool]$Testing) {
    # Fence queued watchdog launches before disabling/stopping the supervisor.
    if (Test-Path -LiteralPath $RootPath -PathType Container) { Write-MemberText (Join-Path $RootPath 'maintenance.flag') 'maintenance' }
    if (!$Testing) {
        $task = Get-ScheduledTask -TaskName 'PaperclipMemberAgent' -ErrorAction SilentlyContinue
        if ($task) {
            Disable-ScheduledTask -TaskName 'PaperclipMemberAgent' -ErrorAction Stop | Out-Null
            Stop-ScheduledTask -TaskName 'PaperclipMemberAgent' -ErrorAction Stop
        }
    }
    $controlFile = Join-Path $ConfigPath 'agent-control.json'
    [void](Assert-PlainPath $controlFile)
    if (!(Test-Path -LiteralPath $controlFile)) { return }
    $identity = Read-MemberJson $controlFile
    $owned = Get-OwnedAgent $identity $RootPath $ConfigPath
    if (!$owned) {
        $stalePid = 0
        if ([int]::TryParse([string]$identity.pid, [ref]$stalePid) -and $stalePid -gt 0 -and !(Get-Process -Id $stalePid -ErrorAction SilentlyContinue)) {
            # Delete only the exact stale identity we read, never a new owner.
            $now = Read-MemberJson $controlFile
            if ($now.pid -eq $identity.pid -and $now.startedAt -eq $identity.startedAt) {
                Remove-Item -LiteralPath $controlFile -Force
                $staleRequest = Join-Path $ConfigPath 'launcher-stop.request'
                [void](Assert-PlainPath $staleRequest)
                if (Test-Path -LiteralPath $staleRequest) { Remove-Item -LiteralPath $staleRequest -Force }
            }
            return
        }
        throw '无法确认正在运行的代理身份；未终止任何进程。请手动退出本安装的代理后重试。'
    }
    $request = Join-Path $ConfigPath 'launcher-stop.request'
    Write-MemberText $request (@{ pid = [int]$identity.pid; startedAt = $identity.startedAt; force = $false } | ConvertTo-Json -Compress)
    Write-Host '正在等待当前任务完成（最多 60 秒）……'
    for ($i = 0; $i -lt 60; $i++) {
        if (!(Get-OwnedAgent $identity $RootPath $ConfigPath)) { return }
        Start-Sleep -Seconds 1
    }
    if (!(Confirm-Member '当前任务仍在运行，是否强制停止？未完成的任务可能需要重试。' $Testing)) { throw '已取消操作；当前任务继续运行，计划任务启动器已停止。' }
    Write-MemberText $request (@{ pid = [int]$identity.pid; startedAt = $identity.startedAt; force = $true } | ConvertTo-Json -Compress)
    for ($i = 0; $i -lt 10; $i++) { if (!(Get-OwnedAgent $identity $RootPath $ConfigPath)) { return }; Start-Sleep -Seconds 1 }
    # Recheck identity immediately before the last-resort process tree termination.
    if (Get-OwnedAgent $identity $RootPath $ConfigPath) {
        & taskkill.exe /PID ([string]$identity.pid) /T /F | Out-Null
        if ($LASTEXITCODE -ne 0) { throw '无法结束本安装的代理，请手动退出后重试。' }
    }
}
if ($Library) { return }
try {
    if (!$TestMode -and ($RemoveConfig -or $RemoveHome -or $RemoveLogs)) { throw '删除选项参数仅供测试；正常卸载必须逐项确认。' }
    $paths = Resolve-MemberPaths $TestMode $InstallRoot $ConfigDir
    $InstallRoot = $paths.Root; $ConfigDir = $paths.Config
    $deleteConfig = Confirm-Member '删除配置和加密 Key 吗？默认保留。' $TestMode $RemoveConfig
    $deleteHome = Confirm-Member '删除 Codex 登录和模型设置吗？默认保留。' $TestMode $RemoveHome
    $deleteLogs = Confirm-Member '删除日志吗？默认保留。' $TestMode $RemoveLogs
    $targets = @($InstallRoot)
    if ($deleteConfig) { $targets += (Join-Path $ConfigDir 'config.json'); $targets += (Join-Path $ConfigDir 'agent-key.dpapi') }
    if ($deleteHome) { $targets += (Join-Path $ConfigDir 'codex-home') }
    if ($deleteLogs) { $targets += (Join-Path $ConfigDir 'logs') }
    Write-Host '将删除以下内容：'; $targets | ForEach-Object { Write-Host ('  ' + $_) }
    foreach ($target in $targets) { [void](Assert-PlainPath $target); if (Test-Path -LiteralPath $target -PathType Container) { [void]@(Get-PlainTree $target) } }
    if (!(Confirm-Member '确认卸载？' $TestMode $true)) { exit 0 }
    Stop-MemberAgent $InstallRoot $ConfigDir $TestMode
    if (!$TestMode) { $task = Get-ScheduledTask -TaskName 'PaperclipMemberAgent' -ErrorAction SilentlyContinue; if ($task) { Unregister-ScheduledTask -TaskName 'PaperclipMemberAgent' -Confirm:$false } }
    foreach ($target in $targets) { Remove-PlainTree $target }
    Write-Host ('卸载完成。保留的用户数据位于：' + $ConfigDir)
    exit 0
} catch { Write-Error ('卸载未完成：' + $_.Exception.Message) -ErrorAction Continue; exit 1 }
