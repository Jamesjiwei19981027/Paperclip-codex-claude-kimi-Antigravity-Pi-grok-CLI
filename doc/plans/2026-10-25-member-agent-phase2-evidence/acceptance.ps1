# 阶段2 A1–A8：由负责人在成员 Windows 电脑执行。
# 只在负责人执行本文件中的步骤时才连接专用服务器；开发验收未执行它。
# 每个区块单独复制；Key 只存在于环境变量，不写入文件、参数或输出。

# 公共准备：在已取得源码和独立 ws 依赖的成员电脑上执行。
$memberRoot = Read-Host '成员端仓库根目录（例如 E:\workspace\paperclip-member-agent-dev）'
Set-Location -LiteralPath $memberRoot
$memberConfigDir = Join-Path $env:APPDATA 'paperclip-member-agent'
[IO.Directory]::CreateDirectory($memberConfigDir) | Out-Null
$memberConfigPath = Join-Path $memberConfigDir 'config.json'
$memberConfig = @{ serverUrl = 'http://192.168.0.213:3100'; executor = 'echo'; projectDirs = @{}; defaultCwd = '' }
[IO.File]::WriteAllText($memberConfigPath, ($memberConfig | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
$memberSecure = Read-Host '输入成员智能体-测试的 API Key（不回显）' -AsSecureString
$memberBstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($memberSecure)
try { $env:PAPERCLIP_AGENT_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($memberBstr) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($memberBstr); $memberSecure.Dispose() }
$memberUrl = 'http://192.168.0.213:3100'
function Get-MemberJson([string] $relative) {
    try {
        Invoke-RestMethod -Uri ($memberUrl + $relative) -Headers @{ Authorization = 'Bearer ' + $env:PAPERCLIP_AGENT_KEY } -Method Get
    } catch {
        if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 403) {
            Write-Host '该读回由负责人在看板或浏览器会话中完成'
            return $null
        }
        throw
    }
}
function Assert-NoMemberKey([string] $text) {
    if ($text.Contains($env:PAPERCLIP_AGENT_KEY)) { throw '验收失败：输出含完整 Key，请只在本机处理，不要粘贴输出。' }
    $text
}

# A1：退出码必须是0。
node .\member-agent\src\main.ts check --config $memberConfigPath
if ($LASTEXITCODE -ne 0) { throw "A1失败，退出码 $LASTEXITCODE" }

# A2：前台运行；应出现“已连接”，并在看板看到成员在线。
# 另开终端做A3/A4；其中重新执行“公共准备”即可，不要把Key写入命令。
node .\member-agent\src\main.ts run --config $memberConfigPath

# A3：先在看板新建仅用于echo的任务，指派给“成员智能体-测试”。
# 保持A2运行，在第二个终端的公共准备后执行以下只读核对。
$memberMe = Get-MemberJson '/api/agents/me'
$memberIssueId = Read-Host '输入刚派发测试工单的UUID（不是Key）'
$memberRunId = $null
if ($null -ne $memberMe) {
    $memberRuns = Get-MemberJson ('/api/companies/' + $memberMe.companyId + '/heartbeat-runs?agentId=' + $memberMe.id + '&limit=1000')
    $memberIssue = Get-MemberJson ('/api/issues/' + $memberIssueId)
    $memberComments = Get-MemberJson ('/api/issues/' + $memberIssueId + '/comments')
    if ($null -ne $memberRuns -and $null -ne $memberIssue -and $null -ne $memberComments) {
        $memberIssueRuns = @($memberRuns | Where-Object { $_.issueId -eq $memberIssueId })
        if ($memberIssueRuns.Count -ne 1 -or $memberIssueRuns[0].status -ne 'succeeded' -or $memberIssue.status -ne 'done') { throw 'A3失败：要求只有一次succeeded运行且工单done，请先等待运行收尾后再核对。' }
        if (-not ($memberComments | Where-Object { $_.authorAgentId -eq $memberMe.id })) { throw 'A3失败：缺少该智能体作者的评论。' }
        $memberRunId = $memberIssueRuns[0].id
        @{ runId=$memberRunId; status=$memberIssueRuns[0].status; issueStatus=$memberIssue.status; runCount=$memberIssueRuns.Count } | ConvertTo-Json
        # 等候60秒再核对；403只转交负责人，不误报测试失败或通过。
        Start-Sleep -Seconds 60
        $memberRunsAgain = Get-MemberJson ('/api/companies/' + $memberMe.companyId + '/heartbeat-runs?agentId=' + $memberMe.id + '&limit=1000')
        if ($null -ne $memberRunsAgain -and @($memberRunsAgain | Where-Object { $_.issueId -eq $memberIssueId }).Count -ne 1) { throw 'A3失败：出现第二次运行。' }
    } else { Write-Host '该读回由负责人在看板或浏览器会话中完成' }
}

# A4：读回完整运行日志并在看板打开同一次运行。程序不会打印Key。
# 运行令牌与工具令牌的全量泄露检查由本地自动化假值测试验证；勿索取真实令牌。
$memberOffset = 0
if (-not $memberRunId) { $memberRunId = Read-Host '输入负责人从看板取得的运行UUID（不是Key）' }
do {
    $memberLog = Get-MemberJson ('/api/heartbeat-runs/' + $memberRunId + '/log?offset=' + $memberOffset + '&limitBytes=100000')
    if ($null -eq $memberLog) { break }
    Assert-NoMemberKey ($memberLog | ConvertTo-Json -Depth 12)
    $memberNext = $memberLog.nextOffset
    if ($null -eq $memberNext -or $memberNext -le $memberOffset) { break }
    $memberOffset = $memberNext
} while ($true)

# A5：先退出旧代理，在配置里加入 echoHoldSec=60，再重新运行。
# 等待仅用于echo验收，期间不写评论、不改工单状态，取消会立即停止等待。
$memberHoldConfig = Get-Content -LiteralPath $memberConfigPath -Raw | ConvertFrom-Json
$memberHoldConfig.PSObject.Properties.Remove('agentKey') # Key始终只通过环境变量传入。
$memberHoldConfig | Add-Member -NotePropertyName echoHoldSec -NotePropertyValue 60 -Force
[IO.File]::WriteAllText($memberConfigPath, ($memberHoldConfig | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
node .\member-agent\src\main.ts run --config $memberConfigPath
# 看板派新工单；出现“收到任务”后约60秒保持running，期间在代理窗口按一次Ctrl+C。
# 在第二个终端执行（运行UUID从看板复制）：
$memberCancelRunId = Read-Host '输入确实运行中按Ctrl+C的运行UUID'
$memberCancelled = Get-MemberJson ('/api/heartbeat-runs/' + $memberCancelRunId)
if ($null -ne $memberCancelled) {
    if ($memberCancelled.status -ne 'failed') { throw 'A5尚未通过：必须确认运行失败收尾，而非已成功或仍运行。' }
    $memberCancelled | Select-Object id,status,errorCode,error | Format-List
}

# A6：沿用 echoHoldSec=60 的配置重新执行以下run，再在看板派新工单。
node .\member-agent\src\main.ts run --config $memberConfigPath
# “收到任务”后60秒等待期间，确认看板仍running，直接关闭代理控制台窗口。
# 第二终端从关闭时开始计时核对，或由负责人直接在看板核对45秒内失败收尾。
$memberCrashRunId = Read-Host '输入异常关闭时仍运行的运行UUID'
$memberDeadline = [DateTime]::UtcNow.AddSeconds(45)
do {
    $memberCrashed = Get-MemberJson ('/api/heartbeat-runs/' + $memberCrashRunId)
    if ($null -eq $memberCrashed) { break }
    if ($memberCrashed.status -eq 'failed') { break }
    Start-Sleep -Milliseconds 250
} while ([DateTime]::UtcNow -lt $memberDeadline)
if ($null -ne $memberCrashed) {
    if ($memberCrashed.status -ne 'failed') { throw 'A6失败：观察45秒仍未失败收尾。' }
    $memberCrashed | Select-Object id,status,errorCode,error | Format-List
}

# A5/A6完成后，在已退出代理的终端恢复 echoHoldSec=0，避免影响A3/A4或后续验收。
$memberHoldConfig = Get-Content -LiteralPath $memberConfigPath -Raw | ConvertFrom-Json
$memberHoldConfig.PSObject.Properties.Remove('agentKey')
$memberHoldConfig | Add-Member -NotePropertyName echoHoldSec -NotePropertyValue 0 -Force
[IO.File]::WriteAllText($memberConfigPath, ($memberHoldConfig | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))

# A7：故意错误的明显假Key；真实Key只临时保存在内存，finally恢复。
$memberSavedKey = $env:PAPERCLIP_AGENT_KEY
try {
    $env:PAPERCLIP_AGENT_KEY = 'FAKE-INVALID-KEY-FOR-ACCEPTANCE-ONLY'
    node .\member-agent\src\main.ts check --config $memberConfigPath
    if ($LASTEXITCODE -ne 3) { throw "A7失败，预期退出码3，实际 $LASTEXITCODE" }
} finally { $env:PAPERCLIP_AGENT_KEY = $memberSavedKey; Remove-Variable memberSavedKey }

# A8：保留第一台A2连接，在第二台Windows电脑使用相同Key运行A2。
# 若只用同一电脑测试，下面为第二个实例使用独立本机状态目录，避免单实例锁先挡住。
# 在第二个已完成公共准备的终端执行；首个代理保持运行。
$memberOriginalAppData = $env:APPDATA
$memberSecondState = Join-Path ([IO.Path]::GetTempPath()) ('member-agent-A8-' + [guid]::NewGuid())
try {
    $env:APPDATA = $memberSecondState
    node .\member-agent\src\main.ts run --config $memberConfigPath
    # 观察“这个智能体已经有另一台电脑在线”，每30秒重试；首连接保持在线。
    # 观察后按Ctrl+C停止第二个代理。
} finally { $env:APPDATA = $memberOriginalAppData }

# 全部结束：在每个验收终端清除环境变量。
Remove-Item Env:PAPERCLIP_AGENT_KEY -ErrorAction SilentlyContinue
