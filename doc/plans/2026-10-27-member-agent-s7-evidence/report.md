# 成员代理 S7 两项产品缺陷修复报告（2026-10-27）

阶段：3，真实验收后修复；本报告按总规格第 14 节回报。

## 结果

已在 E:\workspace\paperclip-member-agent-dev 修复每次运行的 Paperclip HTTP 操作说明、member_agent 创建时的并发默认值，以及尚未接单时的忙碌自动重试。成员端 216 项、服务端指定回归 182 项通过；member-agent 与 server 类型检查前后均为 0 错误。

没有连接专用服务器，未独立读取 BOS-10 / BOS-11 / BOS-12 的远端证据；该背景来自负责人的真实验收说明。本轮结论由本地源码、真实固定版本 Codex + 回环假模型，以及临时数据库/假成员连接验证。没有使用真实 Codex 账号。

## 缺陷一：提示词来源与交付差异调查

1. 服务端唤醒上下文：server/src/services/heartbeat/run-preparation.ts:2217 的 buildPaperclipWakePayload 汇总任务、评论、恢复等信息；server/src/services/heartbeat.ts:3092 调用它，:3118 写入 context.paperclipWake。任务正文由 :3240 调用 heartbeat/task-markdown.ts 的构造器生成，:3274 / :3279 / :3284 / :3289 放入完整、分配和精简文本字段。通信指令在 :3169 单独传入。它们是控制面提供的实际任务/唤醒文字，不是模型自行发现的工具。
2. 成员适配器：server/src/adapters/member-agent/index.ts:6 明确 runtimeToolDelivery 为 environment，且不支持指令包。execute.ts 的 CONTEXT_KEYS 白名单和 job.start 派发把上下文与运行令牌传给成员代理，没有创建 Paperclip 原生控制工具。
3. 成员端：member-agent/src/executors/codex.ts 先物化技能到独立 codexHome，再本地化上下文并调用打包的 codex_local execute。原先“技能文件已复制”不等于模型每次都收到明确的 HTTP 操作说明。
4. Codex CLI 适配器：packages/adapters/codex-local/src/server/execute.ts:593 选取默认模板，:1095 读取已配置的指令文件，:1131 为每次实际尝试生成提示词；:1137 选取任务/唤醒段；:1206 按指令、bootstrap、初始通信说明、唤醒、历史和任务正文拼接。:1202 的续接/恢复分支会省略普通 promptTemplate，因此只改模板或只加 bootstrap 无法覆盖所有运行。
5. 任务选择与续接：packages/adapter-utils/src/server-utils.ts:2184 的初始通信说明在 resumedSession=true 时为空；:2200 的任务选择在续接时可使用精简正文；:2235 的 selectPaperclipPromptSections 统一选取任务正文和唤醒文本。因此本次把说明放在全部四个任务文本载体中，并在缺少正文时仍提供说明，而不依赖模型碰巧读取技能。
6. 实际认证变量：Codex 适配器 execute.ts:897 设置 PAPERCLIP_RUN_ID，:974 将本次运行令牌置于 PAPERCLIP_API_KEY。packages/adapter-utils/src/server-utils.ts:3262 设置 PAPERCLIP_API_URL。成员执行器把其服务地址放进进程环境。技能 skills/paperclip/SKILL.md:22 说明普通接口与认证，:30 规定任务写操作的 X-Paperclip-Run-Id。新说明只引用变量名，绝不嵌入令牌值。

### 确实存在的原生工具假设，供负责人决定

- packages/adapter-utils/src/server-utils.ts:2439：部分恢复提示直接要求把结果写进 resolve 调用的 resolutionNote。该分支按恢复原因选择，没有按 runtimeToolDelivery 区分，environment 成员同样可能收到不存在的调用名。:2341–2343 的 successful_run_missing_state / successful_run_missing_issue_disposition 分支只要求评论及状态；:2435–2437 对这两类原因省略 resolve 这句。未读远端运行，不能断言 BOS-11 每一次唤醒具体走了哪个原因分支。
- 同文件 :230 的通用默认模板拼入 CONNECTION_INTENT_AGENT_GUIDANCE；packages/shared/src/connection-intent-guidance.ts:10 / :12 直接写 connections_search 与 connection_request 工具名。environment 可取得连接工具的普通接口环境说明，但这段通用文字没有向成员解释实际调用方式。
- server/src/services/heartbeat/task-markdown.ts:200 首选 set_task_title，不过同一句已提供 PUT /api/issues/{id}/title 的普通接口后备方式；它不是完全缺少后备路径。
- task-markdown.ts:150–152、:353 的原生附件指令由 nativeRunner 条件控制；server/src/services/heartbeat.ts:3196 仅对 paperclip_runner 设置该标志，task-markdown.ts:354 提供非原生下载方式。不能把这部分概括成所有 environment 成员都会误收到原生附件工具要求。
- server/src/services/native-runtime/native-review-prompt.ts:23 使用 resolve_review，属于原生评审通道；本轮未证明 member_agent 会进入这个原生通道，不作为该成员缺陷的已确认来源。

上述共享提示生成器与 codex_local 源码均未修改。负责人可另行决定把共享恢复/连接提示改为按工具交付方式输出；本轮成员说明明确要求以普通 HTTP 接口处理当前不可用的控制接口指令，同时继续遵守权限、审批、阻塞和任务上下文。

## 缺陷一的具体修复

member-agent/src/executors/codex.ts:133 新增 addPaperclipRestGuidance，:215 在每次适配器调用前加入本地化上下文。说明明确：
- 本成员运行没有 Paperclip 原生工具，评论、确认卡、报告和状态操作走普通 HTTP 接口。
- 每次先用 Get-Content 读取当前 codexHome 下 skills/paperclip/SKILL.md。
- 使用 Invoke-RestMethod、PAPERCLIP_API_URL、PAPERCLIP_API_KEY、PAPERCLIP_RUN_ID，以及任务写操作的 X-Paperclip-Run-Id。
- 提供只引用环境变量的请求头与当前任务读取示例，标明评论 POST 和状态 PATCH 的接口路径。
- 不打印凭据，不因缺少原生工具声称无法操作控制面。

说明加入 paperclipTaskMarkdown、paperclipTaskMarkdownAssignment、paperclipTaskMarkdownCompact、paperclipTaskMarkdownAssignmentCompact；既有正文保留。新增说明不包含 resolve、call_api、update_task、complete_task、resolve_review 等原生工具名。已有服务器唤醒文字仍保留，这与“本轮不修改共享恢复提示”的范围一致，不能宣称整个历史/唤醒载荷都不再出现这些名称。

## 缺陷二：默认并发与忙碌重试

### 创建默认值

server/src/routes/agents.ts:2094 的 normalizeNewAgentRuntimeConfig 现按 adapterType 选择缺省值；:2104 对 member_agent 取 1，其他类型沿用 AGENT_DEFAULT_MAX_CONCURRENT_RUNS（当前 20）。:2119 把适配器类型传入；:4290 聘用入口与 :4597 直接创建入口共用该逻辑。
applyCreateDefaultsByAdapterType 处理的是 adapterConfig；并发位于 runtimeConfig.heartbeat，因此修复放在同一创建流程中专门归一化 runtimeConfig 的函数。

这是缺省值，不是强制上限：明确提供的 maxConcurrentRuns 继续保留，已有记录不迁移。ui/src/lib/new-agent-runtime-config.ts:15 的通用新建辅助函数仍会显式发送通用值 20；如果某个成员创建客户端使用该辅助函数且发送了 20，服务端会把它视为明确配置，不会覆盖。本轮按要求只改服务端缺省处理，没有扩展到 UI。

### 忙碌结果与选择依据

server/src/adapters/member-agent/execute.ts:46 的 busy 结果保留 errorCode=member_agent_busy，返回：
- errorFamily=transient_upstream：已有枚举中最接近“远端成员临时无空闲容量”的类别；它不代表配置错误或账号配额耗尽。
- retryNotBefore=当前时间后 30 秒，与现有短暂失败重试的基本间隔一致。
- executionRecovery={kind:"bootstrap",providerWorkStarted:false}：本次被拒绝任务尚未启动任何执行，允许调度器安全地安排后续运行。它不对占用成员的另一个任务做任何终止或结果推断。

同文件 :64 处理服务器已保留 currentJobId 的情况；:114–126 处理成员在 job.accepted 前返回的严格有效 busy 终态。busy 拒绝不会先 accepted，原逻辑在这里直接当成协议错误。本次只放行确切的 errorCode、exitCode=1、signal=null、timedOut=false 且 schema 合法的接单前拒绝；若已接单或已发起取消，不在这条分支授予尚未执行的重试证明。没有放宽一般结果的接单顺序约束。

依据：
- server/src/services/heartbeat/run-completion.ts:548–560 持久化 errorFamily、retryNotBefore 和 executionRecovery。
- 同文件 :865–869 在失败结果具有短暂恢复合同后调用现有 scheduleBoundedRetryForRun。
- server/src/services/heartbeat/retries.ts:231 / :267 读取这两类短暂恢复字段，:501 要求前次执行无需人工结果核对，:538–546 取默认调度与 retryNotBefore 的较晚时间。
- server/src/services/legacy-execution-recovery.ts:49–56 要求 bootstrap 的未启动证明，未知的执行结果不自动重放。
- retries.ts:113–128 的既有策略为两个自动重试、每次基本间隔 30 秒。本轮不扩充上限、不无限重试。

旧运行在数据库中仍按现有机制记录 failed；区别是持久化为可恢复的临时失败，并生成 scheduled_retry 后续运行，不是把审计历史改写成成功。本轮两项真实调度测试证明：重试记录实际生成，到期后重新发出 job.start，最终 succeeded。

### 已有测试智能体手动设置

由负责人在看板操作：Agents → 对应成员智能体 → Configuration → Run Policy → Max concurrent runs，改为 1 后保存。UI 依据为 ui/src/pages/AgentDetail.tsx:307 的 Configuration 页签、ui/src/components/AgentConfigForm.tsx:1991 的 Run Policy 区、:2077 的 Max concurrent runs 字段。
不要覆盖其他 runtimeConfig 字段。若使用已有已认证的 Board API 会话，可先 GET /api/agents/{id}，保留完整 runtimeConfig 和 heartbeat，仅将 heartbeat.maxConcurrentRuns 改为 1，再 PATCH /api/agents/{id}。更新接口在 server/src/routes/agents.ts:5151；本轮没有发送这类请求或迁移数据。

## 改动文件及行号

1. member-agent/src/executors/codex.ts:133、:215：每次运行的普通接口说明与四个文本载体。
2. member-agent/test/codex-executor.test.ts:61：fresh / resume / recovery / unscoped 四种情况，检查说明、正文保留和凭据值不进入说明。
3. member-agent/test/codex-integration.test.ts:162：真实固定版 Codex 的模型请求也必须收到说明，且不包含测试运行令牌或成员长效 Key。
4. server/src/routes/agents.ts:2094、:2104、:2119：仅 member_agent 的创建缺省并发为 1。
5. server/src/__tests__/agent-permissions-routes.test.ts:1398、:1410、:1421：创建/聘用默认、其他适配器默认不变、明确配置保留。
6. server/src/adapters/member-agent/execute.ts:46、:64、:114：两条忙碌路径和未启动恢复证明。
7. server/src/adapters/member-agent/protocol.test.ts:334、:348、:358、:368：已有原子保留测试加强，以及忙碌拒绝、已接单不重放、真实重试重派测试。

补丁恰含上述 7 个文件，没有数据库变更、codex_local 适配器源码变更、共享恢复提示变更或 UI 变更。

## 新增及修改测试名称与结论

- injects credential-free REST instructions on every fresh run and every selected task carrier：通过。
- 同名 resume / recovery / unscoped 参数化用例：3 项通过。断言说明只含变量名，原生工具名及假凭据值不进入说明，四个载体保留原任务。
- 现有真实 Codex 集成测试的两个用例均加强提示词断言：通过，包括真实工具随机内容往返。
- defaults member_agent to one concurrent run via agents：通过。
- defaults member_agent to one concurrent run via agent-hires：通过。
- preserves the default concurrent run count for process / codex_local：2 项通过。
- preserves an explicit member concurrency setting and unrelated runtime settings：通过。
- reserves one job atomically and releases it after completion：现有用例加强，检查 family、时间与未启动证明，通过。
- treats a valid pre-acceptance member busy rejection as retryable, not a protocol failure：通过。
- does not authorize automatic replay for a busy error after the member accepted work：通过。
- automatically schedules and redispatches an unstarted server busy job through the heartbeat scheduler：通过。
- 同名 member busy 参数化用例：通过。两者都使用实际 heartbeat 服务、临时 PostgreSQL 和回环假成员，检查 scheduled_retry 记录与重派成功；通过提供调度器时间推进到期，不等待 30 秒或增加重试。

## 运行过的命令与完整输出

所有完整输出包含失败和警告，均在本证据目录。不连接 localhost:3100 或专用服务器。run-verify.mjs 为实际隔离命令记录器，调用固定的 Vitest / TypeScript 入口，使用独立 APPDATA、USERPROFILE、HOME、CODEX_HOME，只继承系统环境白名单。每次命令的绝对入口、工作目录和参数另存为对应 *.command.json。

### 改动前基线

- member-before.log：member-agent 目录的完整 Vitest --cache=false --reporter=verbose --maxWorkers=1，16 个文件、212 项通过。
- server-before.log：server 的 src/adapters/member-agent/ 全部测试、src/adapters/registry.test.ts、src/__tests__/agent-permissions-routes.test.ts；4 个文件、173 项通过。
- member-tsc-before.log / server-tsc-before.log：包内 tsc --noEmit，均退出码 0、无错误。
- 改动前失败清单：无。

### 红测与中间失败

- member-red.log：新增四种上下文测试在旧成员执行器上 4 失败、20 通过，缺少说明，退出码 1。
- server-red.log：旧服务端忙碌路径两项断言失败；同次 agent-permissions-routes 的 hoistModuleGraph 初始化钩子在既有 30 秒限制内未结束，导致该文件 93 项未执行。这是该次验证失败记录，不能算作 93 项通过。没有修改钩子超时或跳过其测试。
- create-defaults-red.log：在 E 盘短暂恢复原 routes/agents.ts 后单独运行默认值新增测试，两个真实创建路由的断言都因实际 20、预期 1 而失败。finally 恢复当前实现；没有改 D 盘。
- member-green.log：成员端定向测试 24 项通过。
- 完整输出中保留路由测试对 mock 服务产生的已有警告，未将警告删除或改写。

### 修复后回归及类型检查

命令原样见对应 command.json：

- member-after.log：member-agent 全套，16 个文件、216 项全部通过，EXIT_CODE=0。原 212 项保留，加 4 项上下文测试；包括真实 Codex + 回环假模型 + 工具宿主。
- server-green.log：server 中 src/adapters/member-agent/、src/adapters/registry.test.ts、src/__tests__/agent-permissions-routes.test.ts，4 个文件、182 项全部通过，EXIT_CODE=0，0 跳过。包含原 173 项与新增 9 项；两项真实重试调度测试通过。
- member-tsc-after.log / server-tsc-after.log：两包 tsc --noEmit 退出码 0、无错误。与改动前对比，新增错误均为 0。

没有用放宽断言、加重试或修改测试超时来使回归通过。

## 补丁与隔离证据

补丁：member-agent-s7.patch，SHA-256：
11456BEDAB606E697F1DBD9F1A7421D215A6F0EFD774B9F52C8DE0E451DDF530

路径以仓库根目录为基准，仅含本轮 7 文件。此次没有新增源码文件；临时索引以 D 盘当前同名文件为基线生成 git diff --binary，避免携带早期隔离副本的其他未提交改动。每个目标的 E 开工状态与 D 当前内容一致。

git diff --check 退出码 0。D 当前目标文件只读复制到本证据目录 apply-check/，在临时副本运行 git apply --check，退出码 0、无错误输出。详见 patch-check.log，未向 D 应用。

source-before.json / source-after.json：D 的 7 个目标源码哈希不变。
d-status-before.txt / d-status-after.txt：D 的 git status 完全一致。
isolation.json：D 未改、codex_local 执行器源码 E/D 同样保持原样，无专用服务器连接、commit 或 push。

## 验收项逐条结论

- 提示词来源与原生工具假设调查：完成，位置与适用分支见上文；远端具体运行分支本轮未确认。
- 每次成员运行的环境接口说明：通过单元测试及真实模型请求断言。
- 说明不携带凭据值或原生控制工具名：通过。
- member_agent 新建缺省并发 1、其他类型不变：通过，两创建入口均验证。
- 忙碌结果按既有机制自动重试：通过，实际重试生成、重派、结束均验证。
- 已有数据不迁移、负责人手动操作方法：已说明，未执行远端变更。
- 指定回归和包内类型检查：全部通过。
- D 临时快照补丁检查：通过。

## 偏离本规格的地方

无。没有修改共享恢复/唤醒生成器，未修改 codex_local 源码。服务端生产改动只有 agents 路由默认值及 member-agent 适配器。

## 遇到但未解决的问题

- 共享恢复提示仍可包含 resolve 名称，通用默认模板仍包含连接工具名。本轮用每次成员运行的 HTTP 说明明确当前可用方式，没有替换共享提示生成器。
- 现有 member_agent 并发配置不自动修改；显式传 20 的创建客户端也不会被缺省逻辑覆盖。负责人应把现有测试成员配置改为 1；若希望所有创建入口强制限制或调整 UI 显式默认值，需要另行决定。
- 短暂失败自动重试上限仍为两次。持续忙碌至上限后仍需现有人工处理，不宣称无限排队或永久自动恢复。

## 下一阶段需要负责人确认的事项

审查并决定何时同步补丁；把已有测试成员的最大并发设为 1；在真实 S7 中复验评论/状态操作及多任务顺序执行。共享恢复/连接提示是否按 environment 分支输出、以及 UI 通用显式默认值如何处理，由负责人另行裁定。本轮没有在服务器上进行这些操作。

