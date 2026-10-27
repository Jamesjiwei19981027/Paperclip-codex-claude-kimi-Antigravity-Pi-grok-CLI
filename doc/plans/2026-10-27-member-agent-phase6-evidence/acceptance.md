# 阶段 6 真实安装验收 I1–I9

以下命令未在本轮执行。成员使用没有仓库、没有 Node 的 Windows 电脑和非管理员账户；负责人负责看板读回。PowerShell 示例只在隐藏提示中接收 Key，不将 Key 写进命令行、报告或日志。

## 公共变量（成员）

解压收到的安装包，打开 Windows PowerShell，设置：

```powershell
$packageDir = Read-Host '解压后的安装包目录'
$programRoot = Join-Path $env:LOCALAPPDATA 'Programs\PaperclipMemberAgent'
$configDir = Join-Path $env:APPDATA 'paperclip-member-agent'
$version = { (Get-Content -LiteralPath (Join-Path $programRoot 'current.txt') -Raw).Trim() }
$startFile = { Join-Path (Join-Path (Join-Path $programRoot 'versions') (& $version)) 'start.ps1' }
```

## I1 安装（成员操作，成员读回）

```powershell
Set-Location -LiteralPath $packageDir
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
"安装退出码：$LASTEXITCODE"
Get-Content -LiteralPath (Join-Path $programRoot 'current.txt')
powershell.exe -NoProfile -ExecutionPolicy Bypass -File (& $startFile) -Mode check
"自检退出码：$LASTEXITCODE"
```

按安装提示输入服务器地址、已存在的工作目录，在隐藏输入中填写自己的成员 Key 并完成 Codex 登录。预期校验和五项自检全部通过，版本目录存在，退出码 0。只核对登录文件是否存在，不展示其内容。

## I2 登录自启（成员操作，负责人读回）

成员保存其他工作后执行注销；重新登录后继续：

```powershell
shutdown.exe /l
```

```powershell
Get-ScheduledTask -TaskName 'PaperclipMemberAgent' | Select-Object TaskName,State
Get-ChildItem -LiteralPath (Join-Path $configDir 'logs') -Filter 'launcher-*.log' |
  Sort-Object LastWriteTime | Select-Object -Last 1 | ForEach-Object { Get-Content -LiteralPath $_.FullName -Tail 12 }
```

预期登录触发当前用户任务，无管理员提权；负责人从看板读回该智能体已连接、生命周期 ready。日志不能代替看板确认。

## I3 真实任务（负责人派发和读回，成员读回文件）

负责人在专用测试项目创建任务：读取 README、追加唯一标记、运行 `git --version`，由智能体评论并提交评审。成员只核对测试文件：

```powershell
$projectDir = Read-Host '本机测试项目目录'
Get-FileHash -LiteralPath (Join-Path $projectDir 'README.md') -Algorithm SHA256
Get-Content -LiteralPath (Join-Path $projectDir 'README.md') -Tail 10
```

预期标记、命令和任务结果正确。负责人读回评论作者、确认卡/评审状态、runId、运行次数与用量。

## I4 崩溃自重启（成员操作，负责人读回）

无活动任务时读取仅属于本安装的代理身份，核对进程路径后结束该 Node；不终止其他 Node/Codex：

```powershell
$identity = Get-Content -LiteralPath (Join-Path $configDir 'agent-control.json') -Raw | ConvertFrom-Json
$agentProcess = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$identity.pid)
$agentProcess | Select-Object ProcessId,ExecutablePath,CreationDate
if (!$agentProcess.ExecutablePath.StartsWith((Join-Path $programRoot 'versions') + '\',[StringComparison]::OrdinalIgnoreCase)) { throw '进程不属于本安装，停止操作' }
Stop-Process -Id ([int]$identity.pid)
Start-Sleep -Seconds 20
$newIdentity = Get-Content -LiteralPath (Join-Path $configDir 'agent-control.json') -Raw | ConvertFrom-Json
$newIdentity | Select-Object pid,startedAt
```

预期非预期退出触发首档 10 秒重启，30 秒内重新连接，进程身份改变。负责人从看板确认重新连接；正常退出码 0 不会重启。

## I5 Key 无明文落盘（成员操作和读回）

以下只在内存中获取待查 Key，输出命中的文件路径而非内容；不保存 Key：

```powershell
$secureSearch = Read-Host '输入自己的 Key 以本机检查（不回显）' -AsSecureString
$searchBstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureSearch)
try {
  $searchValue = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($searchBstr)
  $matches = @()
  foreach ($root in @($programRoot,$configDir)) {
    foreach ($file in @(Get-ChildItem -LiteralPath $root -Recurse -File -ErrorAction Stop)) {
      $bytes = [IO.File]::ReadAllBytes($file.FullName)
      if ([Text.Encoding]::UTF8.GetString($bytes).Contains($searchValue) -or [Text.Encoding]::Unicode.GetString($bytes).Contains($searchValue)) { $matches += $file.FullName }
    }
  }
  $taskXml = Export-ScheduledTask -TaskName 'PaperclipMemberAgent'
  if ($taskXml.Contains($searchValue)) { $matches += '计划任务定义' }
  if ($matches.Count) { $matches; throw '检查发现明文；不要展示文件内容' }
  '安装目录、用户数据/日志、计划任务定义未发现 Key 明文'
} finally {
  $searchValue = $null; $bytes = $null; $taskXml = $null
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($searchBstr); $secureSearch.Dispose()
}
```

预期无明文命中，`agent-key.dpapi` 存在且无法由另一 Windows 用户解密。此命令检查程序管理的目录和任务定义；未扫描其他磁盘的任意用户文件，不能据此宣称整机所有文件均已扫描。全盘检查由成员在其权限范围内另行执行，负责人只接收是否命中，不接收 Key。

## I6 升级与回滚（成员操作，负责人读回）

负责人提供代理版本号加一、重新构建且独立告知 ZIP SHA-256 的安装包。成员保存配置、加密 Key、登录的本机哈希，仅输出是否一致：

```powershell
$preservePaths = @((Join-Path $configDir 'agent-key.dpapi'),(Join-Path $configDir 'codex-home\auth.json'))
$beforeHashes = @{}; foreach ($p in $preservePaths) { $beforeHashes[$p] = (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash }
$beforeConfig = Get-Content -LiteralPath (Join-Path $configDir 'config.json') -Raw | ConvertFrom-Json
$oldVersion = & $version
$newPackageDir = Read-Host '新版本解压目录'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $newPackageDir 'install.ps1')
'当前版本：' + (& $version)
foreach ($p in $preservePaths) { if ((Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash -ne $beforeHashes[$p]) { throw '用户数据发生变化' } }
$afterConfig = Get-Content -LiteralPath (Join-Path $configDir 'config.json') -Raw | ConvertFrom-Json
if ($afterConfig.serverUrl -ne $beforeConfig.serverUrl -or $afterConfig.codexHome -ne $beforeConfig.codexHome -or (ConvertTo-Json $afterConfig.projectDirs -Compress) -ne (ConvertTo-Json $beforeConfig.projectDirs -Compress)) { throw '用户配置未保留' }
powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $newPackageDir 'install.ps1') -Rollback
if ((& $version) -ne $oldVersion) { throw '没有回到旧版本' }
```

预期新旧版本共存，用户配置、加密 Key、独立登录保留；当前与上一个指针切换，配置中的程序路径随版本切换。负责人从连接/运行记录读回新旧版本；当前 UI 尚未直接展示 agentVersion，不能把界面标签当作版本证明。

## I7 最低版本门控（负责人配置测试服务器并派发，成员核对提示）

负责人在独立验收环境将 `server/src/adapters/member-agent/settings.ts` 的 `minimumAgentVersion` 调高并按部署流程上线；本轮没有执行该操作。成员先回滚旧版保持连接：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $newPackageDir 'install.ps1') -Rollback
powershell.exe -NoProfile -ExecutionPolicy Bypass -File (& $startFile) -Mode check
'自检退出码：' + $LASTEXITCODE
Get-ChildItem -LiteralPath (Join-Path $configDir 'logs') -Filter 'agent-*.log' |
 Sort-Object LastWriteTime | Select-Object -Last 1 | ForEach-Object { Get-Content -LiteralPath $_.FullName -Tail 12 }
```

预期旧版连接仍保留，任务未执行，返回 `member_agent_version_outdated`，中文说明当前/要求版本以及“请运行新安装包升级”。负责人从看板运行详情读回错误码和没有执行副作用，不能仅凭成员日志认定通过。自检在已有代理运行时可能因单实例锁返回 5；版本门控结论以既有连接上的任务结果为准。

## I8 卸载与数据保留（成员操作和读回）

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $programRoot 'uninstall.ps1')
Test-Path -LiteralPath $programRoot
Get-ScheduledTask -TaskName 'PaperclipMemberAgent' -ErrorAction SilentlyContinue | Select-Object TaskName,State
Test-Path -LiteralPath (Join-Path $configDir 'config.json')
Test-Path -LiteralPath (Join-Path $configDir 'agent-key.dpapi')
Test-Path -LiteralPath (Join-Path $configDir 'codex-home')
Test-Path -LiteralPath (Join-Path $configDir 'logs')
```

分别询问配置/Key、Codex 登录、日志时选择保留。预期程序目录和计划任务删除，选择保留的用户数据仍在。负责人只核对代理离线，不读取成员登录内容。

## I9 中文用户名/路径（成员操作和读回）

有对应条件时，在中文用户名的非管理员账户或带中文、空格的解压路径重复 I1：

```powershell
$packageDir = Read-Host '包含中文和空格的解压目录'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $packageDir 'install.ps1')
'退出码：' + $LASTEXITCODE
```

预期校验、复制、登录、自检均无路径解析错误。负责人从看板读回连接。I9 未在真实第二台电脑执行；自动化只验证临时中文/空格路径。
