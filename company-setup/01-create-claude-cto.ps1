$companyId = '5c3b23be-b2a6-47ca-9e71-d0de8e52105e'
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
    cwd = 'D:\paperclip'
    model = 'claude-opus-5'
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
