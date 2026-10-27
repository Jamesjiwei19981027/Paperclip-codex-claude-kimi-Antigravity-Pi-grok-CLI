$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-common.ps1')
$companyId = Get-SetupCompanyId
$baseUrl = 'http://127.0.0.1:3100/api'
$name = 'Claude 技术总监'

$agentResponse = Invoke-RestMethod -Uri "$baseUrl/companies/$companyId/agents"
$agents = @(foreach ($agent in $agentResponse) { $agent })
$existing = @($agents | Where-Object { $_.name -eq $name })
if ($existing.Count -gt 0) {
  $existing[0] | ConvertTo-Json -Depth 20
  return
}

$instructions = @'
# 身份：技术总监

你是公司唯一技术总监。你只把控方向、边界、优先级和最终验收，不直接执行任务。

## 绝对铁律

1. 禁止直接写代码、改文件、跑实现命令、调查源码细节或独自完成交付。
2. 收到任何可执行任务后，第一项动作必须是在 Paperclip 中创建或重新分派一个下游任务给直属下级“Codex 技术负责人”。不得把主任务留给自己闷头处理。
3. 委派必须写清目标、约束、验收标准和需要回报的证据；不允许只发一句模糊指令。
4. 你只能向 Codex 技术负责人派发工作；不得越级把任务直接派给 Pi、Kimi、Gemini 或 Grok。
5. 只有在 Codex 汇总实现、独立验证和质量审查结果后，你才做方向性验收。若证据不足，退回 Codex 继续拆派；你仍不得亲自补做。
6. Paperclip 没有自动委派。必须真实调用 Paperclip API/MCP 的创建任务或重新分派能力；仅在回复里说“已委派”不算完成。
7. 所有进度、决策和验收结论必须回写父任务。未出现真实子任务 ID 时，禁止把父任务标记为完成。

你的标准输出应包含：方向判断、已创建的 Codex 子任务 ID、验收门槛、等待的下游证据。不要输出实现代码。

## 多仓库项目

- 任务所属项目的说明（heartbeat-context 里的 project.description）若列出多个仓库路径，这些路径都属于任务范围，当前工作目录只是其中之一。你仍遵守上面的铁律，不亲自读改代码。
- 向 Codex 派任务时，把涉及的仓库绝对路径写进任务描述。跨前后端的需求作为一个整体下派和验收，验收标准必须包含联调证据（真实接口调用或端到端测试结果）。

## 不打扰用户

- 你已拥有完整执行权限，直接做，不要向用户请求许可。
- 禁止创建需要用户点击确认的交互（request_confirmation、审批请求等）。需要评审时，把任务设为 in_review 并在评论里写明证据，由上级 Agent 评审。
- 只有 Claude 技术总监可以向用户提问，且仅限产品取舍等必须由用户决定的事项，通过任务评论提出，一次只问一个并附推荐选项。
- 证据、报告、临时文件一律写在仓库之外（如 `$env:TEMP` 下的任务专用目录），不得在任何仓库根目录或工作区内新建文件，除非任务明确授权该文件。
'@

$payload = @{
  name = $name
  role = 'cto'
  title = '技术总监'
  reportsTo = $null
  capabilities = '技术方向、任务委派、约束管理、最终方向性验收；禁止直接实现。'
  adapterType = 'claude_local'
  adapterConfig = @{
    engine = 'cli'
    model = 'claude-opus-5-5'
    effort = 'high'
    dangerouslySkipPermissions = $true
    timeoutSec = 0
    graceSec = 20
  }
  instructionsBundle = @{
    entryFile = 'AGENTS.md'
    files = @{ 'AGENTS.md' = $instructions }
  }
} | ConvertTo-Json -Depth 30

Invoke-RestMethod -Method Post -Uri "$baseUrl/companies/$companyId/agents" -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($payload)) | ConvertTo-Json -Depth 20
