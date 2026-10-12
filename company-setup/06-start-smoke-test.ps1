$companyId = '5c3b23be-b2a6-47ca-9e71-d0de8e52105e'
$ErrorActionPreference = 'Stop'
$baseUrl = 'http://127.0.0.1:3100/api'
$title = '五 Agent 委派与评审联调：数值汇总工具'
$response = Invoke-RestMethod "$baseUrl/companies/$companyId/issues"
$existing = @($response | ForEach-Object { $_ } | Where-Object title -eq $title)
if ($existing.Count -gt 0) {
  $existing | Select-Object id,identifier,title,status | ConvertTo-Json
  return
}
$description = @'
目标：验证真实 Claude → Codex → Gemini/Pi/Grok 委派链和原生评审闭环，交付一个很小的离线工具。

- Claude 只做方向和委派：先读取 D:/paperclip/skills/paperclip/SKILL.md，然后通过运行时注入的 PAPERCLIP_API_URL、PAPERCLIP_API_KEY 和 X-Paperclip-Run-Id 创建 Codex 子任务，不能亲自写实现或跑实现命令。
- Codex 形成短方案，真实创建 Gemini 实现子任务、Pi 独立方案子任务、Grok 风险审查子任务。Pi 在提交独立结论前不得读取 Gemini 实现。
- 交付限于 D:/paperclip/company-setup/smoke/numbers.mjs 和 numbers.test.mjs。不得改 Paperclip 产品源码或依赖，不用外网和新包，不提交 git。
- numbers.mjs 导出 summarizeNumbers(values)。只接受数组，否则抛 TypeError。只汇总 typeof value === 'number' 且 Number.isFinite(value) 的项；其他项计为 ignored。返回 {count,sum,ignored}，空数组返回全零。数值溢出时抛 RangeError。不得把字符串转成数字。测试覆盖空、正常、负数、零、NaN/Infinity、字符串/null/对象、非数组以及溢出。
- Gemini 实现并运行 node --test company-setup/smoke/numbers.test.mjs，把命令与原始结果存为任务证据。Pi 只交独立算法、边界反例和与采用方案的差异。Grok 只交验收与风险，不修改文件。
- Codex 必须在 Gemini 创建时为其配置 executionPolicy.stages=[{type:'review',participants:[{type:'agent',agentId:'f62e68c5-e5ad-42c5-a98f-4f258185e4f5'}]}]。Gemini 交作业用 in_review；Codex 作为真实 currentParticipant 检查文件和测试后通过 PATCH status done 批准，或 status in_progress 要求返工。review/approval 不是独立 decision 端点。
- Claude 等 Codex 子任务时设 status blocked 与 blockedByIssueIds=[Codex子任务ID]；Codex 等三个子任务时同样设置真实 blocker ID。创建子任务后退出，靠事件唤醒，不循环等待。
- 每个 Agent 的全部 issue 写入必须使用运行时身份和 X-Paperclip-Run-Id，回读确认。不要输出任何 token。权限失败不得绕过。
- 每个必要产物存任务文档或 work product；实现源文件留 workspace 时登记 metadata.resourceRef.kind=workspace_file。Codex 汇总三个真实子任务 ID、测试结果和正式评审记录后向 Claude 汇报。Claude 最终只做方向验收。

成功门槛：真实子任务由上级 Agent 自己创建；实现通过测试；Pi 与 Grok 有可检查产出；存在 Codex 原生评审决定；根任务完成。不得用口头声称代替 API 事实。
'@
$payload = @{
  title = $title
  description = $description
  status = 'todo'
  priority = 'medium'
  assigneeAgentId = '8bfcaf41-ced6-42b1-899d-e70efc415385'
  goalId = '6559d6e5-cffd-4c0d-bd07-55e14f79a49b'
} | ConvertTo-Json -Depth 10
$issue = Invoke-RestMethod -Method Post "$baseUrl/companies/$companyId/issues" -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($payload))
$issue | Select-Object id,identifier,title,status,assigneeAgentId | ConvertTo-Json
