# 阶段 3 负责人验收命令（B1–B4、S1–S8）

这些检查由负责人在成员 Windows 电脑和 Paperclip 看板执行。本开发过程没有连接专用服务器。示例使用 PowerShell；Key 只在当前进程环境变量中，绝不写入配置文件或命令参数。先将 `$memberRoot`、`$memberServerUrl`、Codex 路径和项目目录替换成成员电脑上的实际值。

## 公共准备

在一个新的 PowerShell 窗口运行。`runtimeDir` 必须指向已经构建好的 `member-agent\runtime`；`projectDirs` 里的项目 UUID 和目录由看板/负责人核对。此配置不包含 Key。

```powershell
$memberRoot = Read-Host '成员端仓库根目录'
$memberServerUrl = Read-Host 'Paperclip 服务器地址（例如 http://100.64.0.1:3100）'
$memberProjectId = Read-Host '看板项目 UUID'
$memberProjectDir = Read-Host '该项目在本机已存在的工作目录绝对路径'
$memberCodexExe = Read-Host '固定版本 codex.exe 绝对路径'
$memberCodexSourceBin = Read-Host '同一固定版本安装包的 bin 目录（含 codex.exe 和 codex-code-mode-host.exe）'
$memberCodexTargetBin = Split-Path -Parent $memberCodexExe
foreach ($name in @('codex.exe', 'codex-code-mode-host.exe')) {
  $sourceFile = Join-Path $memberCodexSourceBin $name
  if (-not (Test-Path -LiteralPath $sourceFile -PathType Leaf)) {
    throw "同一版本安装包的同一目录必须同时包含 codex.exe 和 codex-code-mode-host.exe；缺少 $name"
  }
}
[IO.Directory]::CreateDirectory($memberCodexTargetBin) | Out-Null
foreach ($name in @('codex.exe', 'codex-code-mode-host.exe')) {
  $sourceFile = Join-Path $memberCodexSourceBin $name
  $targetFile = if ($name -eq 'codex.exe') { $memberCodexExe } else { Join-Path $memberCodexTargetBin $name }
  if ([IO.Path]::GetFullPath($sourceFile) -ne [IO.Path]::GetFullPath($targetFile)) {
    Copy-Item -LiteralPath $sourceFile -Destination $targetFile -Force
  }
}
$memberConfigDir = Join-Path $env:APPDATA 'paperclip-member-agent'
$memberCodexHome = Join-Path $memberConfigDir 'codex-home'
$memberConfigPath = Join-Path $memberConfigDir 'config.json'
$memberRuntimeDir = Join-Path $memberRoot 'member-agent\runtime'
[IO.Directory]::CreateDirectory($memberConfigDir) | Out-Null
[IO.Directory]::CreateDirectory($memberCodexHome) | Out-Null
$memberConfig = @{
  serverUrl = $memberServerUrl
  executor = 'codex'
  projectDirs = @{ $memberProjectId = $memberProjectDir }
  defaultCwd = ''
  codexExecutable = $memberCodexExe
  codexHome = $memberCodexHome
  runtimeDir = $memberRuntimeDir
}
[IO.File]::WriteAllText($memberConfigPath, ($memberConfig | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
$memberSecret = Read-Host '粘贴成员智能体 API Key（不回显）' -AsSecureString
$memberBstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($memberSecret)
try { $env:PAPERCLIP_AGENT_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($memberBstr) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($memberBstr); $memberSecret.Dispose() }
Set-Location -LiteralPath $memberRoot
function Get-MemberCodexProcessTree {
  $all = @(Get-CimInstance Win32_Process)
  $ids = @($all | Where-Object { $_.Name -ieq 'codex.exe' } | ForEach-Object { [uint32]$_.ProcessId })
  do {
    $children = @($all | Where-Object { $ids -contains [uint32]$_.ParentProcessId -and $ids -notcontains [uint32]$_.ProcessId } | ForEach-Object { [uint32]$_.ProcessId })
    $oldCount = $ids.Count
    $ids = @($ids + $children | Sort-Object -Unique)
  } while ($ids.Count -gt $oldCount)
  $all | Where-Object { $ids -contains [uint32]$_.ProcessId } | Select-Object ProcessId,ParentProcessId,Name
}
function Get-MemberApiJson([string] $Path) {
  try {
    Invoke-RestMethod -Uri ($memberServerUrl.TrimEnd('/') + '/api' + $Path) -Headers @{ Authorization = ('Bearer ' + $env:PAPERCLIP_AGENT_KEY) } -Method Get
  } catch {
    if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 403) {
      Write-Host '该读回由负责人在看板或浏览器会话中完成'
      return $null
    }
    throw
  }
}
```

在第一次构建或更新后运行；该命令只在成员端仓库构建运行时：

```powershell
node .\member-agent\scripts\build-runtime.mjs
```

## B1：本机检查

先完成 S1 登录，再执行：

```powershell
node .\member-agent\src\main.ts check --config $memberConfigPath
"退出码: $LASTEXITCODE"
```

预期：可执行文件、同目录的 `codex-code-mode-host.exe` 工具宿主、版本、独立 `codexHome` 登录状态和 runtime 完整性五项分别打印；全部通过时退出码 0。缺少工具宿主时，必须从同一版本安装包的同一目录同时复制这两个 exe，不能只复制 `codex.exe`。若有失败，修复对应项后重跑。

## B2：假模型成功任务

终端一启动假模型服务；它只绑定 `127.0.0.1`，本命令会打印实际随机端口：

```powershell
Set-Location -LiteralPath $memberRoot
node .\member-agent\test\fixtures\fake-model-server.mjs 0 0
```

复制它打印的 `http://127.0.0.1:<端口>`，在终端二设置仅含假模型的独立 Codex 配置。不要加入任何真实账号凭据：

```powershell
$memberFakeModelUrl = Read-Host '粘贴假模型打印的回环 URL'
$memberFakeToml = @(
  'model = "gpt-5.4"',
  'model_provider = "paperclip_acceptance_fake"',
  '[model_providers.paperclip_acceptance_fake]',
  'name = "Paperclip loopback acceptance fake"',
  ('base_url = "' + $memberFakeModelUrl + '/v1"'),
  'wire_api = "responses"',
  'requires_openai_auth = false',
  'request_max_retries = 0',
  'stream_max_retries = 0'
) -join "`n"
[IO.File]::WriteAllText((Join-Path $memberCodexHome 'config.toml'), $memberFakeToml, [Text.UTF8Encoding]::new($false))
node .\member-agent\src\main.ts run --config $memberConfigPath
```

在看板把一个测试任务指派给该成员智能体，任务内容要求“只回复 `B2_FAKE_MODEL_OK`，不要调用工具”。预期：运行成功，活动日志有 Codex JSON 行；运行日志不含服务器端工作目录、`PAPERCLIP_AGENT_KEY` 或运行令牌。独立读回：看板运行详情/日志、任务评论作者和运行状态；若 API 返回 403，由负责人在看板/浏览器完成读回。

## B3：连接中的取消及本机进程树

终端一启动 10 分钟延迟的回环假模型，终端二确认 `$memberCodexHome\config.toml` 的 `base_url` 指向它：

```powershell
Set-Location -LiteralPath $memberRoot
node .\member-agent\test\fixtures\fake-model-server.mjs 0 600000
```

终端二运行代理并在看板派发任务；等运行详情出现 `running` 且本机出现 Codex 进程后，在看板取消。代理终端保持打开：

```powershell
Get-MemberCodexProcessTree
```

取消后重复运行上述进程查询。预期：本次 `codex.exe` 及其子孙进程均消失，运行在服务器 `graceSec + 10` 秒内收尾。独立读回：看板运行状态/错误和本机取消前后进程列表。

## B4：技能真实目录

任务开始前和执行期间分别检查技能是实际目录（不是符号链接）：

```powershell
$memberSkillPath = Join-Path $memberCodexHome 'skills\paperclip'
Get-Item -LiteralPath $memberSkillPath | Select-Object FullName,Attributes,LinkType,Target
Get-ChildItem -LiteralPath $memberSkillPath -Recurse -File | Get-FileHash -Algorithm SHA256
```

预期：目录存在，`LinkType` 为空，文件哈希有输出。任务提示中出现 Paperclip 技能内容，代理不因 Windows 符号链接权限失败。独立读回：本机目录属性/哈希和 Codex 运行日志。

## S1：真实账号设备登录

使用成员真实 Codex 账号时，只在成员自己的控制台执行。登录输出可能有验证码/链接，不要复制到日志或对话：

```powershell
node .\member-agent\src\main.ts login --config $memberConfigPath
node .\member-agent\src\main.ts check --config $memberConfigPath
```

预期：登录写入独立 `codexHome`，check 显示已登录；程序只检查 `auth.json` 是否存在，不读取内容。独立读回：登录终端结果和 check 四项状态。

## S2：真实小任务与独立读回

在一个专用测试仓库中预先建立 `README.md`，指派任务要求 Codex 读取它、追加一行唯一标记、运行一条无害命令、以该智能体身份评论结果并将任务状态设为 `in_review`。完成后在成员终端核对文件：

```powershell
$memberReadme = Join-Path $memberProjectDir 'README.md'
Get-FileHash -LiteralPath $memberReadme -Algorithm SHA256
Get-Content -LiteralPath $memberReadme -Tail 10
```

再从看板独立核对文件内容/哈希、作者为该智能体的评论、状态为 `in_review`、本任务运行次数及用量。评论和状态不以代理自身终端输出作为证据。

可从成员 API 读运行、工单和评论元数据；若权限返回 403，函数会转交负责人在看板读回：

```powershell
$memberMe = Get-MemberApiJson '/agents/me'
$memberIssueId = Read-Host '输入测试工单 UUID'
if ($null -ne $memberMe) {
  $memberIssue = Get-MemberApiJson (('/issues/' + $memberIssueId))
  $memberComments = Get-MemberApiJson (('/issues/' + $memberIssueId + '/comments'))
  $memberRuns = Get-MemberApiJson (('/companies/' + $memberMe.companyId + '/heartbeat-runs?agentId=' + $memberMe.id + '&limit=1000'))
  $memberIssue | Select-Object id,status
  $memberComments | Select-Object authorAgentId,createdAt
  $memberRuns | Where-Object { $_.issueId -eq $memberIssueId } | Select-Object id,status,issueId
}
```

## S3：技能 API 调用归属

使用只允许测试操作的任务，要求 Codex 通过 Paperclip 技能提供的接口完成一步操作。负责人从看板运行日志与活动日志核对 API 调用及 `X-Paperclip-Run-Id` 对应当前运行；在活动日志中确认作者/运行归属。不得从聊天文本推断 API 调用成功。

用看板取得运行 UUID 后，可尝试只读运行日志：

```powershell
$memberRunId = Read-Host '输入看板中本次运行 UUID'
$memberLog = Get-MemberApiJson ('/heartbeat-runs/' + $memberRunId + '/log?offset=0&limitBytes=100000')
if ($null -ne $memberLog) {
  $memberLogText = $memberLog | ConvertTo-Json -Depth 12
  if ($memberLogText.Contains($env:PAPERCLIP_AGENT_KEY)) { throw '日志意外包含当前 Key；不要展示或分享此输出。' }
  $memberLogText
}
```

预期日志/活动记录中的请求携带当前 `X-Paperclip-Run-Id`。独立读回：看板活动日志按该运行 UUID 检索；成员日志接口若 403 则仍由负责人浏览器会话核对。

## S4：真实运行取消

在独立测试仓库指派一个明确要求先启动长时间无害等待、之后再写回的任务；确认运行中后从看板取消。在成员端保存取消前、取消后进程列表：

```powershell
Get-MemberCodexProcessTree
```

预期：在 `graceSec + 10` 秒内 Codex 和子进程全部消失。独立读回看板运行状态及两份本机进程列表。

## S5：服务器下发超时

在测试任务配置中把 `maxRunSec` 设为短值（例如 10 秒），并指派一个需要超过该时间的无害长任务。运行后核对看板以超时失败收尾；在成员端按 S4 命令核对 Codex 及子孙进程在 `graceSec + 10` 秒内消失。独立读回：工单配置、运行状态/错误、前后进程列表。

## S6：会话续接

在同一任务完成首次运行后追加评论，再触发第二次运行。看板核对两个运行编号和日志中的会话信息：如续接则记为续接，如重置则记为重置；本项是待实测，不预设结果。独立读回服务器运行记录和本地会话日志。

```powershell
$memberIssueId = Read-Host '输入同一测试工单 UUID'
$memberRuns = Get-MemberApiJson ('/companies/' + $memberMe.companyId + '/heartbeat-runs?agentId=' + $memberMe.id + '&limit=1000')
if ($null -ne $memberRuns) { $memberRuns | Where-Object { $_.issueId -eq $memberIssueId } | Select-Object id,status,createdAt }
```

预期：出现两次运行记录；会话续接或重置以运行日志中的 `sessionId`/会话参数为准，如成员 Key 无权限则在看板读回。

## S7：两个项目目录隔离

在配置中为两个实际项目分别增加映射（不要把目录写成服务器路径），例如：

```powershell
$memberProjectId2 = Read-Host '第二个项目 UUID'
$memberProjectDir2 = Read-Host '第二个项目已存在的本机绝对目录'
$memberConfig.projectDirs[$memberProjectId2] = $memberProjectDir2
[IO.File]::WriteAllText($memberConfigPath, ($memberConfig | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
```

分别给两个项目指派只在各自测试目录创建不同标记文件的任务。预期：标记只出现在对应本机目录。独立读回：两个目录内文件/哈希和各自看板运行记录。

## S8：Codex 子进程环境不含长期 Key

在仅用于测试的任务中让 Codex 运行下面的命令。它只输出变量名，不读取或输出任何变量值：

```powershell
node -e "process.stdout.write(Object.keys(process.env).filter((name) => name === 'PAPERCLIP_AGENT_KEY').join('\n') || 'PAPERCLIP_AGENT_KEY absent')"
```

预期日志为 `PAPERCLIP_AGENT_KEY absent`。独立读回：看板运行日志内该命令输出和当前运行 ID；确认日志没有任何 Key 值。

## 清理

所有真实任务结束后停止代理和假模型服务，在每个 PowerShell 会话中清除环境变量：

```powershell
Remove-Item Env:PAPERCLIP_AGENT_KEY -ErrorAction SilentlyContinue
```

人工读回依赖的运行列表、活动日志若对成员 Key 返回 403，应标注“该读回由负责人在看板或浏览器会话中完成”，不要把 403 当作代理执行失败，也不要把真实 Key 发给开发者。




