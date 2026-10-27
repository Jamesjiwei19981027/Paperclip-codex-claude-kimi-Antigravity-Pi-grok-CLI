param(
    [switch]$Rollback,
    [switch]$TestMode,
    [string]$InstallRoot,
    [string]$ConfigDir,
    [string]$TestDefaultCwd,
    [string]$TestServerUrl = 'http://localhost:39999',
    [string]$TestExecutor,
    [string]$TestNode,
    [switch]$TestOverwrite,
    [switch]$TestReplaceConfig
)
$ErrorActionPreference = 'Stop'
$installerInputs = @{ Testing = $TestMode; Root = $InstallRoot; Config = $ConfigDir }
. (Join-Path $PSScriptRoot 'uninstall.ps1') -Library
$TestMode = $installerInputs.Testing; $InstallRoot = $installerInputs.Root; $ConfigDir = $installerInputs.Config
function Assert-Version([string]$Version) {
    if ($Version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') { throw '版本记录无效，请重新获取安装包。' }
}
function Test-PackageManifest {
    $all = @(Get-PlainTree $PSScriptRoot)
    # Remove Mark-of-the-Web before inspecting or copying any package files.
    foreach ($file in $all) { if (!$file.PSIsContainer) { Unblock-File -LiteralPath $file.FullName } }
    try {
        $manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'MANIFEST.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        Assert-Version $manifest.agentVersion
        if (!$manifest.nodeVersion -or !$manifest.codexVersion -or !$manifest.runtimeManifest -or !$manifest.builtAt -or !$manifest.repoCommit -or !$manifest.files) { throw '清单字段不完整' }
        $seen = @{}
        foreach ($entry in $manifest.files) {
            $relative = [string]$entry.path
            if (!$relative -or $relative -match '\\|:|(^|/)\.\.?(/|$)' -or $relative.StartsWith('/') -or $relative -notmatch '^(install\.ps1|uninstall\.ps1|README-成员安装说明\.md|app/start\.ps1|app/(node|codex|member-agent)/[^\x00-\x1f]+)$') { throw '非法文件路径' }
            if ($seen.ContainsKey($relative)) { throw '重复清单条目' }; $seen[$relative] = $true
            $filePath = Join-Path $PSScriptRoot ($relative.Replace('/', '\'))
            [void](Assert-PlainPath $filePath)
            $item = Get-Item -LiteralPath $filePath -Force
            if ($item.PSIsContainer -or $null -eq $entry.size -or $item.Length -ne [long]$entry.size -or $entry.sha256 -notmatch '^[0-9a-fA-F]{64}$') { throw '文件大小不符' }
            $stream = [IO.File]::OpenRead($filePath); $hasher = [Security.Cryptography.SHA256]::Create()
            try { $hash = [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
            finally { $stream.Dispose(); $hasher.Dispose() }
            if ($hash -ne $entry.sha256) { throw '文件哈希不符' }
        }
        foreach ($file in $all) {
            if ($file.PSIsContainer) { continue }
            $relative = $file.FullName.Substring($PSScriptRoot.TrimEnd('\').Length + 1).Replace('\', '/')
            if ($relative -ne 'MANIFEST.json' -and !$seen.ContainsKey($relative)) { throw '发现未列入清单的文件' }
        }
        foreach ($required in @('install.ps1', 'uninstall.ps1', 'README-成员安装说明.md', 'app/start.ps1', 'app/node/node.exe', 'app/codex/codex.exe', 'app/codex/codex-code-mode-host.exe', 'app/member-agent/src/main.ts', 'app/member-agent/package.json')) { if (!$seen.ContainsKey($required)) { throw '缺少安装必需文件' } }
        return $manifest
    } catch { throw '安装包已损坏或被修改，请重新获取。' }
}
function Set-ConfigPrograms($Config, [string]$VersionPath) {
    $Config | Add-Member -MemberType NoteProperty -Name 'codexExecutable' -Value (Join-Path $VersionPath 'codex\codex.exe') -Force
    $Config | Add-Member -MemberType NoteProperty -Name 'runtimeDir' -Value (Join-Path $VersionPath 'member-agent\runtime') -Force
    $Config | Add-Member -MemberType NoteProperty -Name 'codexHome' -Value (Join-Path $ConfigDir 'codex-home') -Force
    if ($Config.PSObject.Properties.Name -contains 'agentKey') { $Config.PSObject.Properties.Remove('agentKey') }
}
function Test-MemberConfiguration($Config, [string]$VersionPath, [string]$ValidationRoot = $VersionPath) {
    if (!(Test-Path -LiteralPath $Config.defaultCwd -PathType Container)) { throw '默认工作目录不存在，请先创建目录。' }
    [void](Assert-PlainPath $Config.defaultCwd)
    if ($TestMode) { $node = $TestNode } else { $node = Join-Path $ValidationRoot 'node\node.exe' }
    $oldRoot = $env:PAPERCLIP_INSTALL_VALIDATE_ROOT; $oldKey = $env:PAPERCLIP_AGENT_KEY
    $oldConfig = $env:PAPERCLIP_INSTALL_VALIDATE_CONFIG
    $validationId = [Guid]::NewGuid().ToString('N')
    $validatorPath = Join-Path $ConfigDir ('.validate-' + $validationId + '.mjs')
    $inputPath = Join-Path $ConfigDir ('.validate-' + $validationId + '.json')
    try {
        $env:PAPERCLIP_INSTALL_VALIDATE_ROOT = $ValidationRoot
        $env:PAPERCLIP_AGENT_KEY = $null
        $env:PAPERCLIP_INSTALL_VALIDATE_CONFIG = $inputPath
        # Use a BOM-free file instead of the PowerShell native stdin pipeline.
        # Only the random file path is passed in the environment; never the URL in argv.
        $validator = 'import {readFile} from "node:fs/promises";import {pathToFileURL} from "node:url";import path from "node:path";const base=process.env.PAPERCLIP_INSTALL_VALIDATE_ROOT;const {validateConfig}=await import(pathToFileURL(path.join(base,"member-agent/src/config.ts")));const {assertTransportAllowed}=await import(pathToFileURL(path.join(base,"member-agent/src/transport-check.ts")));try{let text=await readFile(process.env.PAPERCLIP_INSTALL_VALIDATE_CONFIG,"utf8");if(text.charCodeAt(0)===0xFEFF)text=text.slice(1);const config=validateConfig(JSON.parse(text),{},{requireAgentKey:false});assertTransportAllowed(config.serverUrl)}catch{console.error("配置校验失败：请检查服务器纯源地址、内网明文限制和目录设置。");process.exitCode=2}'
        [IO.File]::WriteAllText($inputPath, ($Config | ConvertTo-Json -Depth 30 -Compress), (New-Object Text.UTF8Encoding($false)))
        Write-MemberText $validatorPath $validator
        & $node $validatorPath
        if ($LASTEXITCODE -ne 0) { throw '配置未通过代理校验，尚未保存。服务器须为纯 HTTP(S) 源地址；公网地址必须使用 HTTPS。' }
    } finally {
        try {
            Remove-Item -LiteralPath $inputPath, $validatorPath -Force -ErrorAction SilentlyContinue
        } finally {
            $env:PAPERCLIP_INSTALL_VALIDATE_ROOT = $oldRoot
            $env:PAPERCLIP_INSTALL_VALIDATE_CONFIG = $oldConfig
            $env:PAPERCLIP_AGENT_KEY = $oldKey
        }
    }
}
function Register-MemberTask([string]$VersionPath) {
    if ($TestMode) { return $true }
    try {
        $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
        $start = Join-Path $VersionPath 'start.ps1'
        $arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $start + '"'
        $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
        $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
        Register-ScheduledTask -TaskName 'PaperclipMemberAgent' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
        return $true
    } catch {
        Write-Warning ('开机自启注册失败，可能被公司策略禁止。请联系管理员确认任务计划权限；也可手动执行：powershell -NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $VersionPath 'start.ps1') + '"')
        return $false
    }
}
function Invoke-MemberCommand([string]$VersionPath, [string]$Command) {
    $params = @{ Mode = $Command }
    if ($TestMode) { $params.TestMode = $true; $params.InstallRoot = $InstallRoot; $params.ConfigDir = $ConfigDir; $params.TestExecutor = $TestExecutor }
    # Run the launcher in a child shell: its exit must not end installation.
    $shell = (Get-Process -Id $PID).Path
    $args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $VersionPath 'start.ps1'), '-Mode', $Command)
    if ($TestMode) { $args += @('-TestMode', '-InstallRoot', $InstallRoot, '-ConfigDir', $ConfigDir, '-TestExecutor', $TestExecutor) }
    & $shell @args | Out-Host
    return $LASTEXITCODE
}
try {
    if (!$TestMode -and ($TestExecutor -or $TestNode -or $TestDefaultCwd -or $TestOverwrite -or $TestReplaceConfig -or $PSBoundParameters.ContainsKey('TestServerUrl'))) { throw 'Test 参数仅限显式测试模式。' }
    $paths = Resolve-MemberPaths $TestMode $InstallRoot $ConfigDir
    $InstallRoot = $paths.Root; $ConfigDir = $paths.Config
    if ($TestMode) {
        if (!$TestExecutor -or !$TestNode) { throw '测试模式必须指定假 TestExecutor 和校验用 TestNode。' }
        $temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
        if (![IO.Path]::GetFullPath($TestExecutor).StartsWith($temp, [StringComparison]::OrdinalIgnoreCase)) { throw '假执行器必须位于临时目录。' }
        [void](Assert-PlainPath $TestExecutor)
    }
    $configPath = Join-Path $ConfigDir 'config.json'; $keyPath = Join-Path $ConfigDir 'agent-key.dpapi'
    $currentPath = Join-Path $InstallRoot 'current.txt'; $previousPath = Join-Path $InstallRoot 'previous.txt'
    foreach ($p in @($configPath, $keyPath, $currentPath, $previousPath)) { [void](Assert-PlainPath $p) }
    $current = ''
    $staging = $null; $backupVersionPath = $null; $versionSwapped = $false; $transactionCommitted = $false
    $configPathExisted = Test-Path -LiteralPath $configPath; $oldConfigText = if ($configPathExisted) { Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 } else { $null }
    $currentPathExisted = Test-Path -LiteralPath $currentPath; $oldCurrentText = if ($currentPathExisted) { Get-Content -LiteralPath $currentPath -Raw -Encoding UTF8 } else { $null }
    $previousPathExisted = Test-Path -LiteralPath $previousPath; $oldPreviousText = if ($previousPathExisted) { Get-Content -LiteralPath $previousPath -Raw -Encoding UTF8 } else { $null }
    if (Test-Path -LiteralPath $currentPath) { $current = (Get-Content -LiteralPath $currentPath -Raw).Trim(); Assert-Version $current }
    $versionsPath = Join-Path $InstallRoot 'versions'
    if (Test-Path -LiteralPath $InstallRoot) { [void]@(Get-PlainTree $InstallRoot) }
    if (Test-Path -LiteralPath $ConfigDir) { [void]@(Get-PlainTree $ConfigDir) }
    if ($Rollback) {
        if (!(Test-Path -LiteralPath $previousPath)) { throw '没有可回滚的上一个版本。' }
        $version = (Get-Content -LiteralPath $previousPath -Raw).Trim(); Assert-Version $version
        $versionPath = Join-Path $versionsPath $version
        if (!(Test-Path -LiteralPath (Join-Path $versionPath 'start.ps1'))) { throw '上一个版本不完整，请重新安装。' }
    } else {
        $manifest = Test-PackageManifest; $version = [string]$manifest.agentVersion
        $versionPath = Join-Path $versionsPath $version
        if (Test-Path -LiteralPath $versionPath) {
            if (!(Confirm-Member ('版本 ' + $version + ' 已存在，覆盖吗？') $TestMode $TestOverwrite)) { throw '未覆盖同版本，安装已取消。' }
        }
        [void][IO.Directory]::CreateDirectory($versionsPath)
        # Staging directory prevents partially copied code becoming current.
        $staging = Join-Path $versionsPath ('.staging-' + [Guid]::NewGuid().ToString('N'))
        [void][IO.Directory]::CreateDirectory($staging)
        foreach ($item in @(Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'app') -Force)) { Copy-Item -LiteralPath $item.FullName -Destination $staging -Recurse -Force }
    }
    [void][IO.Directory]::CreateDirectory($ConfigDir)
    if (!$TestMode) { Protect-MemberPath $ConfigDir $true }
    $config = $null
    if (Test-Path -LiteralPath $configPath) {
        $existing = $null; $canReuse = $true
        try { $existing = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json }
        catch { $canReuse = $false }
        if ($canReuse) {
            # Validate before displaying any saved fields; never display credential values.
            Set-ConfigPrograms $existing $versionPath
            try { Test-MemberConfiguration $existing $versionPath $(if ($staging) { $staging } else { $versionPath }) }
            catch { $canReuse = $false }
        }
        if (!$canReuse) {
            if (!(Confirm-Member '现有配置无法通过校验，是否重新填写？' $TestMode $TestReplaceConfig)) { throw '现有配置无效或引用的目录不存在；已保留当前安装，请修复配置后重试。' }
        } else {
            Write-Host ('已有服务器：' + $existing.serverUrl + '；工作目录：' + $existing.defaultCwd)
            if ($Rollback -or (Confirm-Member '沿用现有配置吗？' $TestMode $true)) { $config = $existing }
        }
    }
    if (!$config) {
        if ($TestMode) { $url = $TestServerUrl; $cwd = $TestDefaultCwd }
        else { $url = Read-Host '服务器地址（例如 http://192.168.0.213:3100）'; $cwd = Read-Host '默认工作目录（必须已存在，输入完整路径）' }
        $config = [PSCustomObject]@{ serverUrl = $url; executor = 'codex'; projectDirs = [PSCustomObject]@{}; defaultCwd = $cwd }
        Set-ConfigPrograms $config $versionPath; Test-MemberConfiguration $config $versionPath $(if ($staging) { $staging } else { $versionPath })
    }
    if ($current) { Stop-MemberAgent $InstallRoot $ConfigDir $TestMode }
    if ($staging) {
        if (Test-Path -LiteralPath $versionPath) {
            $backupVersionPath = Join-Path $versionsPath ('.replaced-' + [Guid]::NewGuid().ToString('N'))
            Move-Item -LiteralPath $versionPath -Destination $backupVersionPath
        }
        Move-Item -LiteralPath $staging -Destination $versionPath
        $staging = $null; $versionSwapped = $true
    }
    Write-MemberText $configPath ($config | ConvertTo-Json -Depth 30)
    if (!$TestMode) { Protect-MemberPath $configPath }
    if (!(Test-Path -LiteralPath $keyPath) -or (Confirm-Member '替换已有智能体 Key 吗？' $TestMode)) {
        if ($TestMode) { Write-MemberText $keyPath 'FAKE-DPAPI-TEST-NOT-A-CREDENTIAL' }
        else {
            $secure = Read-Host '智能体 Key（输入隐藏，不要分享给任何人）' -AsSecureString
            try {
                if ($secure.Length -eq 0) { throw 'Key 不能为空。' }
                $encrypted = ConvertFrom-SecureString -SecureString $secure
                Write-MemberText $keyPath $encrypted
            } finally { $secure.Dispose(); $secure = $null; $encrypted = $null }
            Protect-MemberPath $keyPath
        }
    }
    # Config paths and code paths switch together only after validation and drain.
    if ($current -and $current -ne $version) { Write-MemberText $previousPath $current }
    Write-MemberText $currentPath $version
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'uninstall.ps1') -Destination (Join-Path $InstallRoot 'uninstall.ps1') -Force
    # The package/config pointer swap is committed only after all persisted
    # files are written. Keep the old same-version directory until this point.
    $transactionCommitted = $true
    if ($backupVersionPath -and (Test-Path -LiteralPath $backupVersionPath)) { Remove-PlainTree $backupVersionPath; $backupVersionPath = $null }
    if (!$TestMode -and !(Test-Path -LiteralPath (Join-Path $ConfigDir 'codex-home\auth.json')) -and (Confirm-Member '现在登录 Codex 吗？' $false)) {
        $loginCode = Invoke-MemberCommand $versionPath 'login'
        if ($loginCode -ne 0) { Write-Warning 'Codex 登录未成功，请稍后通过 start.ps1 -Mode login 重试。' }
    }
    $checkCode = Invoke-MemberCommand $versionPath 'check'
    if ($checkCode -ne 0) { Write-Warning '自检未通过，文件已保留。请根据上方原因修复配置、Key、网络或 Codex 登录，再执行 start.ps1 -Mode check。' }
    $registered = Register-MemberTask $versionPath
    if (!$TestMode -and $registered -and ($current -or (Confirm-Member '现在启动吗？' $false))) { Start-ScheduledTask -TaskName 'PaperclipMemberAgent' }
    $keep = @($version)
    if (Test-Path -LiteralPath $previousPath) { $previous = (Get-Content -LiteralPath $previousPath -Raw).Trim(); Assert-Version $previous; $keep += $previous }
    foreach ($directory in @(Get-ChildItem -LiteralPath $versionsPath -Directory)) {
        if ($directory.Name -match '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') {
            Assert-Version $directory.Name
            if ($keep -notcontains $directory.Name) { Remove-PlainTree $directory.FullName }
        }
    }
    Write-Host ('安装完成，版本 ' + $version + '。程序位置：' + $InstallRoot)
    Write-Host ('日志位置：' + (Join-Path $ConfigDir 'logs') + '；可查看最近日志或在看板确认上线。')
    Write-Host ('卸载：powershell -ExecutionPolicy Bypass -File "' + (Join-Path $InstallRoot 'uninstall.ps1') + '"')
    exit 0
} catch {
    if (!$transactionCommitted) {
        try {
            if ($staging -and (Test-Path -LiteralPath $staging)) { Remove-PlainTree $staging }
            if ($versionSwapped -and (Test-Path -LiteralPath $versionPath)) { Remove-PlainTree $versionPath }
            if ($backupVersionPath -and (Test-Path -LiteralPath $backupVersionPath)) { Move-Item -LiteralPath $backupVersionPath -Destination $versionPath }
            if ($configPathExisted) { Write-MemberText $configPath $oldConfigText } elseif (Test-Path -LiteralPath $configPath) { Remove-Item -LiteralPath $configPath -Force }
            if ($currentPathExisted) { Write-MemberText $currentPath $oldCurrentText } elseif (Test-Path -LiteralPath $currentPath) { Remove-Item -LiteralPath $currentPath -Force }
            if ($previousPathExisted) { Write-MemberText $previousPath $oldPreviousText } elseif (Test-Path -LiteralPath $previousPath) { Remove-Item -LiteralPath $previousPath -Force }
        } catch { }
    }
    Write-Error '安装未完成；当前版本与配置已保留。请检查安装包、目录权限和配置后重试。' -ErrorAction Continue; exit 1
}
