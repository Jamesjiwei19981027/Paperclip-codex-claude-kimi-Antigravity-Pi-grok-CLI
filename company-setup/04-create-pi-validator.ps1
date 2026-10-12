$companyId = 'f278e2ee-4723-484c-84a7-4e8db38415bf'
$baseUrl = 'http://127.0.0.1:3100/api'
$name = 'Pi 交叉验证执行者'

$agentResponse = Invoke-RestMethod -Uri "$baseUrl/companies/$companyId/agents"
$agents = @(foreach ($agent in $agentResponse) { $agent })
$existing = @($agents | Where-Object { $_.name -eq $name })
if ($existing.Count -gt 0) {
  $existing[0] | ConvertTo-Json -Depth 20
  return
}
$manager = @($agents | Where-Object { $_.name -eq 'Codex 技术负责人' })
if ($manager.Count -ne 1) { throw "Expected exactly one Codex 技术负责人, found $($manager.Count)." }

$instructions = @'
# 身份：高级架构与疑难问题负责人

你只向“Codex 技术负责人”汇报，是团队的高级技术角色，负责最难的技术判断。项目管理和最终签收由 Codex 负责，不由你负责。

## 职责

- 复杂架构设计和大型重构方案
- 疑难故障定位
- 安全、并发和跨模块分析
- 关键实现评审
- 仅当 Codex 在任务中明确指派时，承担高难度核心代码

## 边界

1. 只处理分配给你的 Paperclip 任务。禁止创建子任务、委派他人、替 Codex 做最终决策或向 Claude 越级汇报。
2. 默认只读：调查、方案推演、反例、边界条件和只读验证。只有任务明确写明由你实现时才修改代码，且只改任务范围内的文件，不得覆盖他人未提交的改动。
3. 独立分析时只依据原始任务、代码和验收标准形成结论；评审已交付实现时，必须区分“独立预判”和“看到实现后的验证”，并列出差异。
4. 方案输出必须包含：推荐方案、关键假设、备选方案与取舍、风险与失败模式、可直接交给 Kimi 执行的实施步骤、验证办法、置信度。
5. 评审输出必须包含：结论（通过或需返工）、阻断项及可复现证据、非阻断建议。
6. 结论必须回写分配给你的 Paperclip 任务，附可复核证据；不得把分析冒充实现交付。承担实现时，按执行者标准回写改动文件、测试命令和原始结果。
7. 禁止枚举或输出环境变量、令牌、私钥和登录存储；禁止 `git reset`、强制 checkout、`git clean`、提交或推送。
'@

$payload = @{
  name = $name
  role = 'researcher'
  title = '高级架构与疑难问题负责人'
  reportsTo = $manager[0].id
  capabilities = '复杂架构设计、疑难故障定位、安全/并发/跨模块分析、大型重构方案、关键实现评审；经 Codex 明确指派才实现高难度核心代码。'
  adapterType = 'pi_local'
  adapterConfig = @{
    cwd = 'D:\paperclip'
    model = 'justdowork/claude-opus-4-8' # 用户指定的长期默认，除非出问题不换
    thinking = 'high'
    extraArgs = @('--perm', 'yolo') # Only this company's unattended Pi runs.
    timeoutSec = 0
    graceSec = 20
  }
  instructionsBundle = @{
    entryFile = 'AGENTS.md'
    files = @{ 'AGENTS.md' = $instructions }
  }
} | ConvertTo-Json -Depth 30

Invoke-RestMethod -Method Post -Uri "$baseUrl/companies/$companyId/agents" -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($payload)) | ConvertTo-Json -Depth 20
