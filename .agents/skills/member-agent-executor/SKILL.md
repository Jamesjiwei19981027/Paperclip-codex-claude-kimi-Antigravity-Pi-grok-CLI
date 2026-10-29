---
name: member-agent-executor
description: >
  用于给 Paperclip 成员代理新增或修改执行器（如 CodeBuddy、Claude Code、Gemini CLI），
  排查成员电脑上的执行器、实时转写、代理或进程问题，以及制作、升级和验收成员安装包。
---

# 成员代理执行器接入

本技能说明如何把本机 CLI 接入成员代理，而不是新增一种服务器本地执行方式。当前实现为成员代理 0.3.0，支持 Codex 与 CodeBuddy；动手前重新确认工作树接口。以代码和测试为准，历史计划用于还原验收定义，不能代替运行证据。

共用模块为 `member-agent/src/executors/shared-runtime.ts`（环境白名单、REST 指引、结果筛选等）和 `member-agent/src/executors/shared-support.ts`（目录映射、上下文本地化、技能复制等），Codex 与 CodeBuddy 两个执行器都使用。原文件保留导入或转导出的兼容入口。

先读本文，再按任务读取：

- 打包、升级、自启或停止问题：[安装与运维](references/installation.md)。
- 已知故障与回归位置：[已知坑清单](references/pitfalls.md)。
- 真机交付：[验收清单与实测记录模板](references/acceptance.md)。

公开资料只使用 `http://<服务器地址>:3100` 作为服务器示例。账号、口令、凭据、真实成员目录、主机标识和安装包具体 SHA 均不得进入技能、fixture 或公开证据。中文账户场景统一写“中文 Windows 用户名”。源码中已有的具体地址示例不要复制。

## 1. 架构一页纸

```text
服务器 member_agent 适配器
  ⇄ 出站 WebSocket（成员主动连接）
成员代理主线程：连接、心跳、队列、单任务调度、进程树收尾
  ⇄ Worker 消息
Worker 内执行器：配置隔离、目录本地化、适配器上下文、回调转发
  ⇄ 本地适配器 execute(ctx)
本机 CLI 子进程：结构化输出、工具调用、会话、用量
```

按以下路径阅读并画出新执行器的回调对应关系：

1. `server/src/adapters/member-agent/index.ts` 注册 `member_agent`；`server/src/adapters/member-agent/execute.ts` 构造任务包并接收结果。服务器配置中的 model、command、cwd、env 不会直接派给成员，不能以“在看板填了”认定成员已生效。
2. `server/src/realtime/member-agent-ws.ts` 处理 `/api/member-agent/v1/connect`，按 companyId 和 agentId 定位连接；`member-agent/src/connection.ts` 管理成员侧连接。握手使用成员长期 Key 的认证头，任务使用本次运行的短期 authToken，二者不能混用或写进命令参数。
3. `member-agent/src/main.ts` 选择执行器，把 job.start 交给 `member-agent/src/job-runner.ts`；后者先发 job.accepted 再创建 Worker，避免准备运行时超过服务器 5 秒接单窗口。不得在 WebSocket 接收回调里等待整个任务。
4. `member-agent/src/executor-worker.ts` 加载执行器、构造 hooks，把 log/event/meta/usage/childSpawned/result 消息发回主线程。当前工厂识别 Codex、CodeBuddy、echo 或默认导出；新增工厂必须接线，不能仅增加文件。
5. `member-agent/scripts/build-runtime.mjs` 用 esbuild 打包 `packages/adapters/codex-local/src/server/execute.ts`，成员执行器 `member-agent/src/executors/codex.ts` 加载生成的 runtime 后调用其 `execute(ctx)`。它没有重新实现 Codex 的 CLI 命令、会话和输出解析逻辑。新执行器优先复用对应本地适配器；没有现成适配器时才实现 CLI 桥接，并实测下文接口。

协议以 `member-agent/src/protocol.ts`、成员连接代码和服务器 execute/ws 代码共同为准；服务器没有独立的 protocol.ts，`protocol.test.ts` 是测试文件。

- 连接：成员发 `hello`（agentVersion、codexVersion、hostname、platform）；服务器回 `hello.ack`（heartbeatSec、maxRunSec、pinnedCodexVersion、minimumAgentVersion）或 `hello.reject`。
- 保活：应用层 `heartbeat` / `ping`，以及 WebSocket 控制帧 ping/pong。不要把 pong 当作虚构的业务 JSON 帧。保活不代表任务有输出。
- 派发：服务器发 `job.start`，包含 jobId、companyId、agent、authToken、context、config、runtime、runtimeTools、handoffMarkdown、codeSyncDir；成员先回 `job.accepted`。
- 实时：`job.log` 带 stream/chunk/seq；`job.event` 带 event/seq；`job.meta` 带 meta；`job.usage` 带 usage。日志和事件序号分别单调递增，由 runner 生成。
- 结束：成员发且只发一次 `job.result`，结果字段直接位于帧顶层；服务器发 `job.cancel`（jobId、graceSec）要求停止。
- 限制：v 为 1，只收 UTF-8 文本 JSON；单帧最多 256 KiB，单个日志 chunk 最多 32 KiB。不要自行绕开 UTF-8 分块、脱敏、队列和严格校验。

验证：参考 `member-agent/test/connection.test.ts`、`member-agent/test/job-runner.test.ts` 和 `server/src/adapters/member-agent/protocol.test.ts`，覆盖先接单、心跳不中断、序号去重、外来 jobId 被忽略、断线取消及结果不向新连接重放。

## 2. 执行器接口清单

接口源文件：`member-agent/src/executors/types.ts`。实现 `Executor`，提供只读 `name` 和 `execute(hooks): Promise<ExecutorResult>`；不要在主线程运行阻塞 CLI 调用。

### 启动与输入

- `hooks.job`：只读 JobStart；jobId 对应 runId，companyId 用于公司范围，agent 是本次身份，config.maxRunSec 是时间上限。context 是任务上下文，runtime 是续接信息，runtimeTools 是可为空的临时工具访问，handoffMarkdown 是独立历史交接文本。codeSyncDir 不是成员 cwd，更不是自动同步服务。
- `hooks.serverUrl`：成员配置的可达服务器根地址；工具访问 endpoint 必须按它重定位源地址，不能使用服务器自见地址。
- `hooks.signal`：取消信号，必须传到适配器和 CLI 生命周期；启动前已取消时不再创建工具进程。
- 复用本地适配器时，参照 `member-agent/src/executors/codex.ts` 的 ctx：runId、agent、runtime、config、context、executionTarget、authToken、getFreshSessionHandoff、signal 及所有回调。Codex 强制 engine=cli、command 为绝对 .exe、cwd 为成员目录、managedAiConnection=true、extraArgs 为空。

### 实时回传

- `log(stream, text)` → job.log。保留 stdout 原始结构化 JSON 行及换行，及时流式发送；不要只在运行结束后发送汇总。看板转写依赖原始 stdout，只有 event 或最终 summary 不能替代它。
- `event(event)` → job.event。必填 eventType；可选 stream、level、color、message、payload，具体枚举按 protocol 校验。
- `meta(meta)` → job.meta。必填 adapterType、command；可选 cwd、commandArgs、commandNotes、env、prompt、promptMetrics、context。其中 adapterType 可以标识底层适配器，但当前 UI 不会仅凭这一字段自动切换解析器。
- `usage(checkpoint)` → job.usage。必填 complete；可选 attemptId 和 Accounting 字段。区分阶段检查点和最终结果的 usageComplete，不能重复累计 session_cumulative 用量。
- `childSpawned(pid)`：在每次 spawn 成功、拿到正整数 PID 后立即登记。runner 去重，最多接受 64 个根 PID；不能漏登记外部启动器或依赖“CLI 已退出”推断其后代已退出。

runner 丢弃无效 meta/usage 并在本机收尾日志报告计数；无效 event/result 会导致任务失败。日志、meta、event 和结果均要脱敏；不得把原始异常或凭据放进 errorMeta。

### 取消、超时、进程树

1. 将 AbortSignal 传给复用适配器；自行 spawn 时实现取消监听和退出等待。服务端 graceSec 当前为 20 秒，成员入口将其限制在 0–20 秒。grace 到期后 runner 强制终止 Worker，再收尾已登记的进程树。
2. maxRunSec 默认 3600，服务端接受 1–14400 秒；成员 runner 也有独立定时器，Codex 本地适配器另收到 timeoutSec。三层不能相互替代。
3. `member-agent/src/process-tree.ts` 保留 PID 与 OS 创建时间，追踪已退出父进程留下的后代，防止误杀复用 PID。默认 3 秒采样，不能保证捕捉两个采样间隔之间出现又消失的所有父子链。
4. `member-agent/src/process-sampler.ts` 为每个 tracker 复用一个隐藏 PowerShell 查询进程，而不是每次采样新开进程；查询失败最多退避重启 3 次，继续使用已有身份记录。
5. 正常结果、取消、超时、断线都走 runner 收尾。断线后抑制旧运行输出；清理失败必须返回 `member_agent_process_tree_termination_failed`，不能宣称成功停止。停止确认由服务器生成，执行器不能伪造 resultJson.executionCancellation。

验证：`member-agent/test/codex-lifecycle.test.ts`、`member-agent/test/process-tree.test.ts`、`member-agent/test/process-sampler.test.ts`、`server/src/adapters/member-agent/cancellation.test.ts`。加入父进程先退出、孤儿再派生、PID 复用、采样器失败、同步卡死 Worker、清理失败以及停止后重新领任务场景。

### 结果字段白名单与错误码

必须同步核对三处：`member-agent/src/executors/types.ts`、`member-agent/src/protocol.ts` 和 `server/src/adapters/member-agent/execute.ts` 的 resultSchema。必填 `exitCode`（整数或 null）、`signal`（字符串或 null）、`timedOut`（布尔值）。其余允许字段如下，不能透传适配器的整个返回对象：

- 错误：errorCode、errorMessage、errorFamily、retryNotBefore、errorMeta。errorFamily 只允许 configuration、transient_upstream、provider_quota、model_refusal、refresh_token_reused、refresh_token_expired、refresh_token_invalidated 或 null；retryNotBefore 是带时区的有效 ISO 时间或 null。
- 内容和会话：summary、resultJson、sessionId、sessionDisplayId、sessionParams、clearSession、usageComplete、executionRecovery。
- Accounting：usage、usageByModel、usageBasis、provider、biller、model、billingType、costUsd、costUsdExact、costStatus、pricingContext、pricingProvenance、cacheAdjustedCostUsd、providerRequestId。
- usage 含 inputTokens、outputTokens，另可带 cachedInputTokens、cacheWriteTokens，数值均非负；usageByModel 的元素仅含 model、usage、costUsd。usageBasis 为 per_run、session_cumulative 或 null。
- billingType 为 api、subscription、metered_api、subscription_included、subscription_overage、credits、fixed、unknown 或 null；costStatus 为 reported、estimated、unpriced。精确金额用 costUsdExact，不要把 token 总量当费用。
- pricingContext 只含 serviceTier、contextTier；pricingProvenance 只含 source、version、evidence、inputCentsPerMillion、cachedInputCentsPerMillion、outputCentsPerMillion、cacheWriteCentsPerMillion、serviceTier、contextTier。source 为 provider_reported、provider_invoice、operator、rate_card、unknown；contextTier 为 short/long。嵌套对象也严格校验。
- executionRecovery 只允许两种证明：bootstrap + providerWorkStarted=false；或 interrupted + providerStopped=true + sessionPreserved=true + actionOutcomes=settled。没有证据不填，不能凭失败退出码开放自动重试。

Codex 的 safeResult 会告警并丢弃未知顶层字段；绕过它直接发未知字段会触发 Worker/服务端严格校验失败，不能概括成“所有层都会静默丢弃”。如需新增字段，先修改完整契约和测试。

沿用现有错误语义：配置 `member_agent_configuration_error`；目录 `member_agent_cwd_unresolved` / `member_agent_cwd_missing`；运行时 `member_agent_runtime_missing`；技能复制 `member_agent_skill_install_failed`；执行器异常 `member_agent_executor_error`；工具失败 Codex 使用 `member_agent_codex_failed`；超时 `member_agent_timeout`。新工具需要专属错误时用 `member_agent_<执行器>_failed` 并增加测试。正常取消沿用例外 `cancelled`，不要自行改名。连接层另有 offline、busy、not_accepted、protocol_error、version_outdated 等 member_agent 系列码。

验证：沿用 `member-agent/test/codex-executor.test.ts` 的假 runtime 回调，覆盖白名单/未知字段/无效嵌套值、非零退出无错误码、短安全异常信息，以及最终用量与会话透传。

## 3. 目录映射

在 `member-agent/src/executors/codex-support.ts` 的 resolveLocalCwd / localizeContext 上扩展，别对任务文本做全局替换。

1. projectId 优先取 context.paperclipWorkspace.projectId，再取 context.projectId；用成员配置 projectDirs 的项目 ID 映射。没有有效映射才使用非空 defaultCwd；都没有就失败，不能退回代理目录。
2. 拒绝相对路径、含父目录段的路径、UNC；工作目录必须已存在且为目录。禁止位于配置目录、执行器专属 home、runtime、成员个人默认 Codex 配置目录内；同时检查词法路径与 realpath，防止目录联接绕过。
3. 错误要包含配置中的目录和修复办法；权限错误、缺目录、路径指向文件要能区别。仅在本机/授权任务诊断展示路径，公开证据脱敏。
4. 本地化 adapter config.cwd、runtime.sessionParams.cwd、paperclipWorkspace.cwd 和独立 agentHome，删除服务器 worktreePath、paperclipWorkspaces 及旧交接副本；历史交接走专用回调。
5. markdown/summary/description/prompt/guidance 中的疑似服务器路径只计数告警，任务文本保持原样；不要自动同步代码、创建工作树或改写文件操作指令。

验证：`member-agent/test/codex-support.test.ts` 与 `member-agent/test/codex-executor.test.ts`；逐项检查映射优先级、缺失路径文案、禁用目录联接、连续两项目隔离、原始任务文本逐字未变。

## 4. 独立配置目录与凭据位置

先实测新 CLI 凭据到底存在哪里，再决定能否隔离：临时专属 home 中登录一次，观察文件创建位置、系统凭据库和注销效果；只记位置类别、存在性和是否变化，不记录内容。不能因为设置某个 HOME 类变量就认定隔离成功；若工具仍强制写个人目录，先写清阻碍，不能把它当成已接入。

- Codex 的专属目录由 codexHome 指定，对子进程设置 CODEX_HOME；安装器使用配置数据目录中的 codex-home。不得指向成员个人默认目录。现有校验仅显式拒绝默认个人 Codex 目录；其他个人配置位置仍需人为核查，不能声称代码自动识别所有个人目录。
- `member-agent/src/executors/codex.ts` 的 PROCESS_ENV_ALLOWLIST 保留系统路径、临时目录、个人目录定位变量、区域/架构等基础项，删除继承的其他变量，再显式注入平台/工具环境。保留 USERPROFILE/HOME 是 Windows 工具运行需要，不是授权读取个人工具配置。
- 该 process.env 清理发生在 Worker 内；Worker 默认环境副本不会回写主线程。不要改成共享环境或在主线程清空环境。任务密钥只经上下文进入适配器，不能继承主代理长期 Key 或无关模型密钥。
- `member-agent/src/codex-cli.ts` 的 buildLoginEnvironment 是单独的登录白名单；登录用 device auth、继承终端，不采集终端输出到日志。检查登录仅判断 auth.json 是否为文件，不读取其内容。
- managedAiConnection=true 避免复用宿主的共享认证缓存；技能先复制为真实目录，参照 materializeSkills，不能依赖 Windows 符号链接权限。更新技能使用暂存、备份与原子替换。

验证：`member-agent/test/codex-cli.test.ts`、`member-agent/test/codex-executor.test.ts`、`member-agent/test/codex-support.test.ts`；在真实成员电脑补查个人配置前后未改变，专属目录之外无新增凭据。对新工具分别验证登录、任务、续接、注销四种路径。

## 5. 系统代理只作用于工具子进程

复用 `member-agent/src/executors/codex-proxy.ts` 的 resolveCodexProxy / queryWindowsProxy，按任务重新读取当前设置。

1. 已有 HTTP_PROXY、HTTPS_PROXY、ALL_PROXY（含大小写形式）优先；没有才读取 HKCU 的 Internet Settings 手动代理。用系统绝对路径 reg.exe，一次 query，隐藏窗口、shell=false、5 秒超时；不要为读代理额外启动 PowerShell。
2. 支持简单地址、http/https 分项和仅 SOCKS；PAC 自动脚本暂不执行，告警后沿现有逻辑处理。不要把“系统代理开启”误判为 CLI 已使用代理。
3. 合并已有 NO_PROXY、注册表绕过项、本机回环项和平台服务器 hostname，大小写变量保持一致。只返回工具子进程环境 overlay，不修改主代理或系统设置。
4. `member-agent/src/connection.ts` 的 WebSocket 使用 agent=false 直连服务器；工具代理不得影响平台通道。runtimeTools endpoint 另按 serverUrl 重定位。
5. redactProxyAddress 遮住代理凭据；Codex 执行器还清理工具回显中的代理地址，覆盖 log/meta/event/result。不得记录未经处理的代理 URL 或原始注册表错误。

验证：`member-agent/test/codex-proxy.test.ts` 与 `member-agent/test/codex-executor.test.ts`，覆盖环境优先、PAC、注册表失败仅告警一次、每任务重读、NO_PROXY 合并、真实子进程收到了代理且主线程未改变。真机做直连/子进程代理对照，记录耗时和安全错误摘要；check 只显示代理选择，不证明联网成功。

## 6. 无原生工具时操作平台

`server/src/adapters/member-agent/index.ts` 声明 `runtimeToolDelivery = "environment"`，`server/src/services/heartbeat.ts` 按它选择工具交付方式；成员执行器本地化 context 时也设置同值。runtimeTools 的连接访问凭据与普通平台 authToken 作用不同，不能互换。

在 `member-agent/src/executors/codex.ts` 的 addPaperclipRestGuidance 中，要求读取本机 Paperclip 技能，使用 Invoke-RestMethod。平台变量由适配器注入：PAPERCLIP_API_URL、PAPERCLIP_API_KEY、PAPERCLIP_RUN_ID、PAPERCLIP_TASK_ID。只引用变量，不打印其值：

```powershell
$headers = New-Object 'System.Collections.Generic.Dictionary[string,string]'
$headers.Add('Authorization', ('Bearer ' + $env:PAPERCLIP_API_KEY))
$headers.Add('X-Paperclip-Run-Id', $env:PAPERCLIP_RUN_ID)
$issueUrl = $env:PAPERCLIP_API_URL.TrimEnd('/') + '/api/issues/' + $env:PAPERCLIP_TASK_ID
Invoke-RestMethod -Method Get -Uri $issueUrl -Headers $headers
```

评论用 POST /api/issues/{id}/comments，状态用 PATCH /api/issues/{id}，JSON 写操作指定 application/json 并携带上述两个请求头；审批、checkout、评审和阻塞规则继续按 `skills/paperclip/SKILL.md` 执行。不要把设置 in_review 当成完成评审。

恢复提示也必须是普通 REST：`packages/adapter-utils/src/server-utils.ts` 对 environment 输出 GET /api/issues/{id}/recovery-actions 和 POST /api/issues/{id}/recovery-actions/resolve，提交 actionId、outcome、sourceIssueStatus、resolutionNote，按实际返回的允许动作处理。`packages/adapter-utils/src/prompt-sections.test.ts` 验证这一分支；不能再提示调用当前不存在的原生 resolve 工具。

REST 指引必须前置到全部四个 task markdown 载体：paperclipTaskMarkdown、paperclipTaskMarkdownAssignment、paperclipTaskMarkdownCompact、paperclipTaskMarkdownAssignmentCompact。首次启动、续接、压缩提示、续接失败转新会话会选择不同载体；communication guidance 在续接时可能省略，仅向它或完整 markdown 注入会丢失规则。compact 缺失时用对应完整文本补齐。

验证：`member-agent/test/codex-integration.test.ts` 检查假模型实际收到的提示包含无原生工具说明、环境变量名和运行头且无凭据；补测四载体，以及 fresh/resume/compact/fallback 分支。真实任务必须成功写回一次评论并通过权限/评审流程，不能只看模型说“已操作”。

## 7. 看板转写解析器

1. 当前 `ui/src/adapters/member-agent/index.ts` 注册 memberAgentUIAdapter，type 为 member_agent，按行顶层 type 分流（Claude/CodeBuddy stream-json vs Codex JSONL），同时保留 SchemaConfigFields 和 buildSchemaAdapterConfig。
2. `ui/src/adapters/registry.ts` 导入并注册此对象；`ui/src/adapters/adapter-display-registry.ts` 管显示信息。仅修改显示注册表不能使运行转写生效。
3. 顶层 type 为 system、assistant、user、result、stream_event 时交给 Claude 解析器；其余以及非 JSON 行交给 Codex 解析器。新 CLI 先实测类型和字段是否有歧义，再决定是否扩展分流；不能假设 meta.adapterType 会自动切换解析器。
4. fixture 位于 `ui/src/adapters/member-agent/fixtures/`：Codex 用 `ui/src/adapters/member-agent/fixtures/codex-stdout.jsonl`，CodeBuddy 用 `ui/src/adapters/member-agent/fixtures/codebuddy-default.jsonl`、`ui/src/adapters/member-agent/fixtures/codebuddy-tools.jsonl`、`ui/src/adapters/member-agent/fixtures/codebuddy-auth-failure.jsonl`。通过 `ui/src/adapters/member-agent/index.test.ts` 和 `ui/src/adapters/member-agent/codebuddy.test.ts` 的 buildTranscript/getUIAdapter 验证工具开始/结果、思考、assistant、用量、错误、纯文本、分块、CRLF、末行无换行、交错格式及 result 后重复 init。

验证：fixture 解析后有 tool_call/tool_result/assistant/result，而不是所有行都是 stdout；再按验收清单观察运行未结束前的逐条输出。任何 UI 改动遵守 token 层，并运行 token gates。

## 8–12. 安装、运维、时间控制、故障和验收

第 8 节安装包、第 9 节看门狗与停止标记、第 10 节时间控制的完整操作与验证见 [安装与运维](references/installation.md)。第 11 节每条“现象 → 根因 → 修复位置 → 验证方法”见 [已知坑清单](references/pitfalls.md)。第 12 节原始 I1–I9、实时过程、团队并行、自动恢复和覆盖安装等见 [验收清单](references/acceptance.md)。执行相应任务时必须读取对应参考文档。

## 13. 新执行器接入总流程

1. **实测 CLI 事实。** 在专用试验目录记录非交互命令、stdin、JSONL、退出码、登录/凭据位置、专属配置隔离、模型选择、取消和孤儿行为。不要凭 CLI 名称推断兼容性。用验收参考文档末尾模板记录，不公开原始凭据或真实路径。
2. **写规格。** 明确复用哪个本地适配器、差异、四载体 REST 指引、协议结果映射、解析器选择、安装包来源/固定校验、取消与验收标准。仓库计划按 `doc/plans/` 的日期命名约定；只读或限目录任务不要越界新建计划。
3. **实现接线。** 从现有模式扩展执行器、config 校验、main 的 check/login/version 和选择、Worker 工厂、连接版本门控、runtime 构建、安装包文件白名单及 UI 转写。当前支持 echo/codex/codebuddy，hello 保留 codexVersion 并增加 executor/executorVersion；异构工具不能把自己的版本冒充 Codex 版本。仅增加配置分支不代表完整接线。
4. **单测与隔离集成。** 用假 runtime 覆盖 hooks/安全结果/配置；用真实 CLI + 本机假模型验证结构化输出和 code-mode 类工具读文件；最后真账号真机验证平台闭环。假模型成功不证明真实网络、登录、团队或升级成功。
5. **打包。** 在有既有构建依赖的隔离副本运行构建；成员安装包包含独立运行所需内容。不得在目录联接的 node_modules 上运行安装命令。新增工具若需依赖，先安排真正独立的依赖目录与批准的来源，不能破坏共享主目录。
6. **真机验收与报告。** 逐项执行 I1–I9 及扩展项，保存脱敏证据、失败原因、版本、命令和未测范围；安装、恢复和平台任务都通过才宣称完成。失败运行后智能体显示 error 是既有平台行为，不为执行器接入顺便修改。

最小验证命令示例（从仓库根目录依次进入对应目录）：

```powershell
Set-Location member-agent
node ..\node_modules\vitest\vitest.mjs run --config vitest.config.ts --cache=false test/codex-executor.test.ts test/codex-support.test.ts test/job-runner.test.ts
Set-Location ..\ui
pnpm exec vitest run src/adapters/member-agent/index.test.ts src/adapters/member-agent/codebuddy.test.ts
Set-Location ..
pnpm exec vitest run server/src/adapters/member-agent/protocol.test.ts server/src/adapters/member-agent/cancellation.test.ts
pnpm check:token-gates
```

新执行器补自己的用例后再选最小相关集；PR-ready 交接按根 AGENTS.md 完整执行 typecheck、test:run、build。不要把本技能中的验证建议描述成本次已运行。

### 代码与历史计划差异

- `doc/plans/2026-10-25-member-agent-phase3-spec.md` 范围段曾写“把任务里所有服务器路径换成本机路径”；当前 localizeContext 只改结构化本地字段，任务正文只告警不改写，以代码和 codex-support 测试为准。
- 同一计划要求 check 打印 runtime MANIFEST 版本详情；Codex 的 main/codex-cli 主要检查文件存在性、工具版本和登录存在性；CodeBuddy 额外逐文件校验安装包和 runtime 哈希，不能混称两者均只查存在性。
- `doc/plans/2026-10-27-member-agent-phase6-installer-spec.md` 原来只有登录触发、版本目录启动器；当前安装器新增 5 分钟看门狗和安装根目录稳定启动器。负责人记录的启动器被杀后 3 分钟内恢复不是当前代码的最坏时限保证，必须重新计时验收。
- 阶段 6 计划末尾仍列原生恢复提示、父进程先退出的后代清理为遗留问题；当前 REST 提示与 PID/创建时间快照已做相应处理，仍需验证采样窗口限制。
- 安装操作看 `member-agent/installer/README-成员安装说明.md`。当前 Codex 连接允许支持窗口内版本差异并告警，安装包仍固定版本，不应把旧计划“版本不相等一律拒绝”当现状。

交付前执行 `python .agents/skills/member-agent-executor/scripts/verify-docs.py`，再对整个技能目录运行敏感信息 rg 扫描，人工核查未命中的人名、主机名与目录。该脚本只读文件，不安装依赖、不运行产品测试，不替代人工审阅。

## 14. 实例：CodeBuddy 执行器（0.3.0）

这是按上述流程接入的完整样例，事实限定于内置 CodeBuddy 2.169.0。后续升级仍需重测，不把单次实测当作永久能力保证。

**实测事实。** 非交互 `stream-json` 与 Claude 同构，可复用助手、工具调用/结果和用量解析；终态 result 后可能重复 init，最终会话以 result.session_id 为准。进程退出码 0 也可能 result.is_error=true，必须按终态判失败。`CODEBUDDY_CONFIG_DIR` 隔离会话、设置、模型和技能配置，无法隔离登录：凭据固定在 `%USERPROFILE%\AppData\Local\CodeBuddyExtension\Data\Public\auth\Tencent-Cloud.coding-copilot.info`，与成员本机插件共用。只查存在性，不读、复制或记录内容。真实取消在工具等待中完成，登记的进程树零残留；`-y` 下已实测命中 HIGH 风险规则的临时目录删除命令不挂起，此结论只限该版本和实测拼写，不代表任意命令均获准。

**用户决定。** 共用成员现有 CodeBuddy 登录，不另造独立账号；安装包内置固定 2.169.0，以批准的 npm integrity 核对来源，再对包内文件逐项记录并校验大小和哈希。技能不抄具体 SHA、账号、服务器地址或人名。

**实现方式。** `member-agent/scripts/build-runtime.mjs` 打包既有 claude_local execute；`member-agent/src/executors/codebuddy.ts` 复用该 CLI 引擎及 shared-runtime/shared-support。`member-agent/src/executors/codebuddy-launcher.ts` 生成 npm 标准 .cmd 垫片，复用层将其解包为 Node + TS 启动器直接运行，提示词不经 cmd.exe。参数只转换两处：将 `--append-system-prompt-file` 改为文本参数（超过 20000 字符前置到 stdin），以及删除 Claude 默认模型/改用显式 codebuddyModel；空模型走账号默认值，`claude-*` 模型拒绝且不传。Paperclip 技能复制为真实目录，平台操作走 REST 环境指引，代理只作用于工具子进程。

**结果和时间控制。** `member_agent_codebuddy_login_required` 表示需要登录；`member_agent_configuration_error` 表示模型或配置不正确；`member_agent_codebuddy_failed` 表示其他工具失败，既有上游分类保留；运行时缺失用 `member_agent_runtime_missing`，执行器异常用 `member_agent_executor_error`。取消用 `cancelled`，本地 15 分钟无输出兜底用 `member_agent_timeout`，真实清理失败仍用 `member_agent_process_tree_termination_failed`。服务端时间控制 A 同样在 15 分钟无输出时停止；runner 的单次 finish 和服务端的 resultSeen/settled 防重复结果，超时码在停止白名单中，不会误报清理失败。

**安装包和自检。** `--executor codebuddy` 输出 CodeBuddy 变体，安装到 `versions/0.3.0-codebuddy`；默认 Codex 变体保留独立目录，版本指针、升级和回滚配置同步切换。缺少各自登录凭据时询问“现在登录 CodeBuddy 吗？”或“现在登录 Codex 吗？”，同意调用 start.ps1 -Mode login，已登录不问。CodeBuddy 自检检查固定版本、完整安装包清单、runtime 哈希、共享登录存在性和代理选择；完整 check 还需要服务器连接成功。`check` 未登录失败，`run` 仅中文告警后上线，任务的登录失败原因可在看板看到；版本、清单或 runtime 不完整仍禁止启动。回归入口为 `member-agent/test/codebuddy-executor.test.ts`、`member-agent/test/codebuddy-startup.test.ts`、`member-agent/test/codebuddy-cli.test.ts`、`member-agent/test/codebuddy-installer.test.ts`、`member-agent/test/installer-login.test.ts`，其余配置、启动器、连接和 runtime 测试按职责补齐。

**已知限制。** 解压路径不宜过深：包内最长相对路径约 150 字符，建议解压到短目录，尤其避免 PowerShell 5.1 Expand-Archive 超过 260 字符。每次启动逐文件校验约 3 秒；这是本机观察，不是性能保证。共享登录的退出/续期会同时影响 CLI 和插件，不能用更换 CODEBUDDY_CONFIG_DIR 避开。
