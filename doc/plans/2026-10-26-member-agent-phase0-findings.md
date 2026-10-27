# 成员本机智能体：阶段 0 核对结果

核对日期：2026-10-25（Asia/Shanghai）。文件名日期按实现规格指定为 2026-10-26。  
范围：只读核对当前工作区源码，回答 Q1–Q6；只新增本文件。实测脚本、工作目录、Codex 配置和输出均在系统临时目录。未修改实现规格、可行性文档或产品代码，未运行 git commit / git push。  
状态：阶段 0 证据已整理，存在规格缺口；等待负责人裁定，不进入阶段 1。本文不代表服务器集成、真实账号任务、取消进程树或 frp 验收通过。

## 开头先列出：需要负责人决定

1. **需要负责人决定——路线 A 使用哪个引擎。** 复用库可以走通，不必因此切换路线 B；但当前 `execute()` 默认走 ACP，不是 `codex exec`。默认 ACP 的命令配置与 CLI 不同，不能仅把 `config.command` 指向固定 `codex.exe` 就认定已钉住实际运行版本。建议明确成员代理内部选择 `engine: "cli"`，或另行确认固定 ACP 入口及其 Codex 依赖的方案。本次直接 CLI 已用规格要求的 **0.160.0** 实测通过；默认 ACP 也通过隔离的协议探针，但不等于已验证成员安装包及其无 `.cmd` 启动。影响 §8.2、§8.3、§9、阶段 3/6。依据见 Q2、Q3。
2. **需要负责人决定——补齐回调和协议。** §6 没有 `job.event`，却要求路线 A 转发 `onEvent`；`job.usage` 只列 `UsageSummary`，实际回调是带完整性和计费属性的 `AdapterUsageCheckpoint`；结果包漏掉会话、计费和错误分类等字段。服务器端新适配器还必须自行调用 `onCancellationReady`，否则不能仅凭监听 `ctx.signal` 承诺看板取消能传到代理。影响 §5.1、§6、§7.2、§8.2。依据见 Q1、Q2。
3. **需要负责人决定——历史交接与工具能力的交付范围。** `getFreshSessionHandoff` 由服务器查询数据库生成，成员端不能原样执行；需要明确服务器下发有界快照，还是按需回调服务器。现有 `codex_local.runtimeToolDelivery` 实际是 `native_mcp`，§5.1 的“environment 与 codex_local 一致”不成立。新方案可以采用 environment，但必须承认能力差异，并明确是否提供既有 MCP/运行工具。不能把服务器私钥或内部地址随整个 ctx 序列化。影响 §5.1、§6.2、§8.2。依据见 Q2。
4. **需要负责人决定——成员端 API 地址与本地路径的重建规则。** 实测只设置 `config.env.PAPERCLIP_API_URL` 时，子进程实际收到的是 `http://localhost:3100`；必须由成员代理自己的运行环境正确设置地址。上下文中的目录、scratch、工作树和会话 cwd 也都是服务器路径，不能只改一个 `config.cwd`。影响 §8.1、§8.2、阶段 3/5。依据见 Q3、Q5。
5. **需要负责人决定——令牌边界写清楚。** 默认 JWT 有效期为 **48 小时，可由实例环境覆盖**，并非随一次运行结束立即失效、也不是仅授权一个任务的能力票据。默认覆盖四小时上限，但实际实例 TTL 未确认。应确定 TTL 前置检查，以及缺失令牌时在新适配器内明确失败；如要新增到期自动刷新或结束即撤销，超出现有规格，需要另定范围。影响 §3、§5.1、§10。依据见 Q4。
6. **需要负责人决定——固定版本的信任来源和校验清单。** Runner 的 Codex 版本检查不是通用的 Windows 下载器，也不能把 runnerd 的 SHA-256 检查说成 Codex 下载包完整性验证。建议发布时固定 Codex 主包和 Windows 平台包的预期 SRI/哈希，并限定下载来源；本次没有实现或验收下载、升级、替换和回滚。影响 §8.3、阶段 6。依据见 Q6。
7. **需要负责人决定——§5 改动白名单与 §7.1 的认证复用要求冲突。** 现有 `live-events-ws.ts:131` 的 `authorizeUpgrade` 是未导出的内部函数，且 `:142` 接受 URL 查询参数 token。要求复用/抽取它，同时禁止改这个文件或新增公共认证 helper，目前不能同时兑现。需批准最小认证抽取范围，或明确另一种经评审的复用边界；不能直接复制整个逻辑并顺带接受 URL token。依据：`server/src/realtime/live-events-ws.ts:131`、`:142`、`:214`、`:221`。本次未修改任何认证代码。

这些是待裁定事项，不是已采取的方案。Q1 未发现“没有服务器 PID 就一定误杀”的障碍，Q2 也未证明路线 A 不可行；现阶段没有据此改用 Paperclip Runner / PRP 的理由。

## 核对基线与证据限制

- 核对顺序：先完整阅读实现规格（尤其 §0、§2、§11、§12、§14），再完整阅读可行性文档，然后按 §12 指定位置核对实现及其调用方。
- 依据为 `D:\paperclip` 的当前工作区，包含任务开始前已有的未提交修改，不是仅按 HEAD 推断。行号均指本次核对时的文件。后续二审若工作区变更，需重新定位。
- 运行前后查看的 Git 状态中，既有修改列表相同；本次仓库内只新增本文。未执行安装、构建、迁移、任务派发、真实凭据读取或实例配置修改。Q3 读取已有安装的 Codex 可执行文件，在临时目录产生测试状态。
- 为避免额外产物写入仓库，没有运行全仓测试、类型检查或构建。这是源码核对和隔离探针，不是阶段 1 的实现验收。
- Q3 原始日志、脚本全文和完整命令在本文附录；包括裸 Node 加载失败及 CLI 自带的告警/401。没有把这些删掉或改写成“无错误通过”。

## Q1：没有本地进程号时，怎么超时和回收？

### 结论

**已确认代码行为：正常仍被当前服务器执行器持有的运行，不会只因 `processPid` 为空或五分钟没输出，就被 orphan reaper 判为进程丢失。`onDispatch()` 不是超时定时器，也不是存活证明。远端执行必须在新适配器内实现总时长、接收确认、断线和取消等待的边界。**

具体分开看：

1. `activeRunExecutions` 在进入执行时加入 runId，执行器 finally 退出时移除。reaper 判断 `runningProcesses`、`activeRunExecutions` 和 native controller 所有权；本地仍跟踪的运行直接跳过。因此即使一直无输出，未结束的 `execute()` 仍受当前执行器跟踪。
2. 失去内存所有权后，reaper 先检查其他活跃 legacy controller，再检查陈旧阈值。没有可用进程存活证据的遗留 running 记录可能被置为 `failed / process_lost`。普通无 PID 运行**不能依赖本地进程丢失的一次自动重试**；该重试另有 tracked-local-child / monitor 条件。
3. 周期 reaper 调用的五分钟是陈旧候选阈值，不是“任何运行五分钟没日志就杀”。启动时也有不带该阈值的回收调用。
4. 静默监控是另一条路径：当前阈值为五分钟 suspicious、十五分钟 critical。普通静默任务的扫描会保留已有评估或跳过，不能等同为自动停止。只有任务已有同一次运行的终态证据等特定条件才走 fold；不是无限等待的替代保障。
5. `onDispatch` 的语义是释放/推进派发边界；普通非特定 continuation 的调用甚至传入空函数。它不会创建一个一小时计时器。
6. 现有 HTTP 适配器自己设置请求超时，默认 `timeoutMs=0`；OpenClaw Gateway 自己设置 connect/wait 超时，默认 `timeoutSec=120`。两者都是适配器承担等待边界的先例，不能据此声称 heartbeat 会替新适配器限时。
7. 取消也是单独的控制协议：服务器只有在适配器调用 `onCancellationReady` 后，才注册可加入等待的运行控制。新 `member_agent.execute()` 应在远端派发前使用服务器提供的该回调，并在自身退出前完成约定的取消等待。成员本机的 PID 不可作为服务器本机 PID 传给服务器的 `onSpawn`。

### 依据（文件:行号）

- `server/src/services/heartbeat.ts:2415`：加入 activeRunExecutions；`:2421`：启动 legacy controller lease；`:7985`：finally 移除并结束控制。
- `server/src/services/heartbeat/recovery.ts:2139`：locallyTracked 包含 activeRunExecutions；`:2185`：跟踪与 controller 检查先于陈旧判断；`:2190`：updatedAt 阈值；`:2254`：重试资格；`:2270`：process_lost 失败写入。
- `server/src/index.ts:1532`：启动回收；`:1798`：周期回收传五分钟阈值。
- `packages/adapter-utils/src/types.ts:277`：onDispatch 契约；`server/src/services/heartbeat.ts:4937`：普通 dispatch 的空回调；`:7202`：传入适配器。
- `server/src/services/recovery/service.ts:172`、`:173`：静默阈值；`server/src/modules/active-run-watchdog/domain/policy.ts:24`：静默起算时间；`server/src/modules/active-run-watchdog/application/use-cases.ts:256`、`:266`：同 run 终态证据；`:296`：普通情况保留已有评估或跳过。
- `server/src/adapters/http/execute.ts:11`、`:26`、`:32`：自有定时器和 onDispatch；`packages/adapters/openclaw-gateway/src/server/execute.ts:1081`、`:1365`：自有请求等待超时。
- `server/src/services/heartbeat.ts:7224`；`server/src/services/adapter-execution-control.ts:65`：注册运行取消控制。
- `server/src/services/heartbeat/run-lifecycle.ts:546`、`:560`：onSpawn 的 PID 会持久化；`:1023`、`:1120`：无 PID 的 queued-cancel 分支只是启动取消证据，不是远端运行 watchdog。

### 对规格的影响

§7.3 的有界等待方向成立，应保留；§7.2 需补上 `onCancellationReady`，不能只写 `ctx.signal`。§7.3 “由现有失败重试/唤醒机制处理”需要注明**不是保证立即重试、不是保证本机残留执行已停止**。`onSpawn` 只在成员端用于管理本机子进程，不上送为服务器 PID。无需因为无 PID 而改 heartbeat 核心或新增数据库表。

**未确认：**专用服务器上静默运行三十分钟以上、服务器重启后真实任务的呈现、取消后 Windows 子进程树是否全部消失；缺阶段 1/2/4 的集成运行证据，本次没有伪造这类验收。

## Q2：函数型上下文字段实际用了哪些？

### 结论

**路线 A 可复用现有库，但必须分 CLI / ACP 引擎讨论；并非把 ctx JSON 化再补两个日志函数即可。**

CLI 分支直接解构 `runId/agent/runtime/config/context/onLog/onMeta/onEvent/onSpawn/authToken`，还读取 `executionTarget`、`executionTransport`、`agentIdentity`、`runtimeMcp.getServers()`、`runtimeCommandSpec`、`onRuntimeProgress`、`onUsage` 和 `onProviderStopped`，通过 helper 调用 `getFreshSessionHandoff`。其主进程调用没有传入 `ctx.signal`，也没有调用 `ctx.onCancellationReady` 或 `ctx.onDispatch`。本次 CLI 回调计数与此一致。

ACP 为默认引擎，额外真实使用 `onCancellationReady` 和 `signal`，并使用 `onEvent` / 执行阶段回调生成本地运行日志事件，使用 `onProviderStopped` 完成停止后的收集边界。不能拿 CLI 那一处解构当作全部调用面。

各字段应按以下边界处理：

- **成员端就地满足：**`signal` 由本机 AbortController 产生；本机 `onSpawn` 管理可执行文件/进程树；`onLog/onMeta/onEvent/onUsage/onRuntimeProgress` 在成员端做消息发送封装。服务器接收后调用服务器自己的相应回调。远端 PID 只作为诊断元数据，不调用服务器 onSpawn。
- **服务器端必须保留语义：**服务器新适配器自己调用 `ctx.onDispatch`、`ctx.onCancellationReady`。成员端同名回调不能代替服务器注册运行控制。`onProviderStopped` 若用于服务器侧收集，必须由服务器在可信的停止结果边界调用；成员端只能提供本机停止事实，不能代替宿主收集逻辑。由于本期禁用指令包，可限定不提供相关收集能力，但应明示差异。
- **服务器生成、成员不能独立计算：**`getFreshSessionHandoff()` 调用 DB-backed history loader。普通已知 fresh 的 legacy dispatch 已预装 `context.paperclipFreshSessionHandoffMarkdown`；但 resume 失败转 fresh 的惰性调用仍要有明确处理。可选择发送一个有界快照供本机 callback 返回，或新增受 run/company 限制的按需请求；这是待裁定选项。**不能无条件用 `async () => null` 冒充**，因为 helper 会删除已有交接字段。
- **同步 getter 可重建，但数据不自动齐备：**`runtimeMcp.getServers()` 可以在成员端基于允许的快照实现；端点必须对成员可达，令牌需按秘密处理。现有任务包没有该字段，也未说明 `runtimeTools` 的交付。若本期只支持 environment + REST/runtime skill，应说明与当前 native_mcp 的差异。
- **不能原样传输：**`startupTraceContext` 含 tracer/函数，可省略以保持 no-op，不因此新增遥测。`agentIdentity` 含服务器私钥，不属于“可以把整个 ctx 发过去”的数据；本规格没有授权扩大发送这类凭据。`stopRemoteStartup` 是服务器 sandbox 的停止回调，对成员本地 target 不适用。

现有协议还存在三处结构缺口：

1. 没有 `job.event`，默认 ACP 实测确实发出了 `run.startup.step` / `run.phase.timing` 等 onEvent 事件；这些走本地 run log，不是新增 telemetry 事件。
2. `job.usage` 应承接 `AdapterUsageCheckpoint`，包括 `complete`、`attemptId`、`usageBasis`、provider/biller/billingType 等；只传三项 token 数不能保持现有计费语义。
3. `job.result` 需明确 `sessionId/sessionDisplayId/clearSession`、`errorFamily/retryNotBefore`、`usageComplete/usageBasis`、计费属性和必要 resultJson 等字段的白名单及校验。返回 `sessionParams` 本身不足以说明会话 codec 与错误/恢复语义如何保留。新适配器未注册 codec 时有通用对象 codec，故不应误说“完全不能保存”；但该默认 codec 的 displayId 只识别 sessionId，不能声称与 Codex codec 完全相同。

### 依据（文件:行号）

- `packages/adapter-utils/src/types.ts:237`：完整 ctx；`:43`：AdapterUsageCheckpoint；`:102`：AdapterExecutionResult；`:231`：含 privateKeyPem 的身份类型。
- `packages/adapters/codex-local/src/server/execute.ts:572`、`:587`、`:591`：引擎分流与 CLI 解构；`:628`：target；`:758`：identity 与 MCP；`:1039`：runtimeCommandSpec；`:1132`：交接；`:1332`：onSpawn；`:1338`：onUsage；`:1343`：进程调用参数；`:1235`：身份环境；`:573`：provider stop boundary。
- `packages/adapters/codex-local/src/server/acp.ts:77`、`:88`：默认 ACP；`:360`：共享 ACP executor。
- `packages/adapter-utils/src/acpx-engine/execute.ts:1944`：MCP getter；`:3050` 附近及 `:3091`：交接；`:4051`：取消就绪；`:4305`：onSpawn；`:4802`：onMeta；`:4914`：abort 监听；`:4967`：用量；`:5475`：provider-stopped。
- `packages/adapter-utils/src/acpx-engine/startup-timing.ts:677`、`:859`：onEvent；`packages/adapter-utils/src/server-utils.ts:2174`：交接 helper；`server/src/services/heartbeat.ts:3953`、`:3975`：服务器 loader 和已知 fresh 快照；`server/src/services/native-runtime/native-session-handoff.ts:13`、`:47`：数据库来源。
- `server/src/adapters/registry.ts:330`、`:332`：codex_local 是 native_mcp；`:345`：Codex session codec。
- `server/src/services/heartbeat/run-state.ts:820`、`:839`：默认 codec；`packages/adapters/codex-local/src/server/index.ts:73`：Codex codec。

### 对规格的影响

补齐 §6 的事件、计费 checkpoint、结果消息；明确 §8.2 的引擎和回调所有权。CLI 的取消要由成员代理自己可靠地终止本机树，不能把 AbortController 传给库就当作已实现。§5.1 的 runtimeToolDelivery 对照说明应更正。保留不修改已有适配器、不加表、不新增遥测的约束。

**未确认：**按需历史 RPC、MCP 在成员端/穿透域名下的可达性、会话跨两次真实 run 的续接、宿主停止收集是否可以安全省略。缺新的协议实现及服务器集成测试。

## Q3：独立 Node 环境能直接调用 execute 并用本地目标跑通吗？

### 结论

**能在独立 Node + 现有 tsx 加载器环境中，从 `@paperclipai/adapter-codex-local/server` 调用 `execute()`，并用本地目标启动真实 Codex 0.160.0，得到成功结果。路线 A 的导入和本地执行边界可行。**

但不能扩大结论：

- 包根 `@paperclipai/adapter-codex-local` 的 `execute` 为 undefined，应导入 `/server` 子路径。
- 当前仓库 export 指向 TypeScript 源码；裸 `node q3-probe.mts cli` 在解析内部 `.js` 引用时以 `ERR_MODULE_NOT_FOUND` 失败，exit 1。tsx 处理此源码布局后可成功。这不证明已发布 dist 包不能用裸 Node；发布包安装实测为**未确认**。
- CLI 初次用机器已有 0.163.0 成功，但该版本超出规格窗口，不能用这次结果替代钉版证据。随后另用仓库已安装的 **0.160.0 原生 exe** 成功，未下载或替换个人版本。
- 默认 ACP 探针也成功。其实际日志的 adapter command 是仓库 `codex-acp.cmd`，`config.command` 没有选择这个 ACP 入口；独立代理安装包能否以固定 Node 入口、固定依赖而完全不依赖 `.cmd`，本次**未确认**。该次打印的 CODEX_VERSION 是全局 exe 的预检，不是 ACP 子进程版本证明。
- 这是**真实适配器 + 真实 CLI 进程 + 回环 Responses 协议 fixture**，不是伪造 CLI JSON 输出，但 fixture 返回固定内容和固定 usage，**没有调用真实推理账号**。证明提示词进入适配器、CLI 请求 fixture、结果解析和回调通路；不证明真实模型完成编程、API 写回、权限、成本准确性或 frp。
- 所有测试 CODEX_HOME 均位于临时目录，没有复制或读取个人 auth.json。模型名仅是 fixture 请求字段。CLI 会自动请求 featured-plugin 元数据并得到 401；完整输出保留。不能把本次称为完全无外网请求，也不能把 fixture 的“subscription”标签当成真实账号计费证据。

实测结果：

- 裸 Node：exit 1，缺 `packages/adapter-utils/src/session-compaction.js`。
- tsx + 显式 CLI / 0.163.0：exit 0，summary `Q3_LOCAL_EXECUTE_OK`，1 次回环请求；CLI 未调用 onCancellationReady/onDispatch。
- tsx + 默认 ACP：exit 0，同一 summary，1 次回环请求；onCancellationReady 1 次、onEvent 13 次、onSpawn 1 次、onUsage 2 次。
- tsx + 显式 CLI / **0.160.0**：exit 0，同一 summary，1 次回环请求；onSpawn 1 次、onUsage 2 次，API URL 成功使用成员代理进程环境里的回环地址。

还独立核对到一个配置行为：前两次只在 `config.env` 中设置 API URL，metadata 中实际仍为 `http://localhost:3100`；钉版这次在代理进程 `process.env.PAPERCLIP_API_URL` 设置测试地址后，metadata 正确为 `http://127.0.0.1:<fixture port>`。这是实测，不只是文档推测。

### 依据（文件:行号）

- `packages/adapters/codex-local/package.json:15`、`:28`、`:64`：源码 exports、发布 dist exports、Node >=24.11.0。
- `packages/adapters/codex-local/src/server/index.ts:1`：导出 execute；`packages/adapters/codex-local/src/server/execute.ts:599`：CLI command；`:638`：cwd；`:1225`：参数；`:1343`：本地执行调用。
- `packages/adapter-utils/src/server-utils.ts:3258`：API 地址取进程环境；`packages/adapters/codex-local/src/server/execute.ts:896`、`:943`、`:992`：运行环境生成；`packages/adapter-utils/src/acpx-engine/execute.ts:2023`：已生成的 PAPERCLIP_* 不被 config.env 覆盖。
- 本文附录的 `q3-probe.mts` 完整脚本、四份 stdout/stderr 与 exit code；`pnpm-lock.yaml:3267`、`:3302`：本次钉版依赖来源。

### 对规格的影响

路线 A 可继续作为候选，写清 `/server` 导入、开发与发布加载方式、成员代理自己内部设置的引擎/命令/目录/环境。固定 exe、CODEX_HOME、API 地址来自本机配置，不能放宽 §9 服务器可控字段白名单。不要因裸源码 Node 导入失败便直接判定必须走路线 B。

**未确认：**无仓库依赖的干净 Windows 安装、真实账号及真实 Paperclip 任务、完整 session 续接与取消、独立发布 dist 的导入。缺阶段 3/4/6 的环境和集成证据。

## Q4：authToken 有效期、权限与 supportsLocalAgentJwt

### 结论

**已确认默认有效期 48 小时，可用 PAPERCLIP_AGENT_JWT_TTL_SECONDS 覆盖；supportsLocalAgentJwt 表示 legacy 直接适配器应由 heartbeat 签发并注入运行 JWT，不表示“必须在服务器本地跑进程”。member_agent 要沿用这种认证，标志应为 true。**

- 令牌携带 agent、company、adapterType、runId、responsibleUserId 等 claims，使用按实例/公司派生的签名密钥。默认 scope 为 standard，技能测试运行另有 skill_test scope。
- 中间件核对公司和 agent；拒绝 terminated / pending_approval；如请求携带 X-Paperclip-Run-Id，则必须与签名的 run_id 相同。认证主体是 agent，不是 board；具体操作继续受现有公司、任务和权限检查约束。
- 这不是“只准读取或修改当前任务”的一次性能力票据，standard 权限没有在签发时缩成某个 issue allowlist，也不是长期连接 API Key 的同一对象。
- 不存在普遍的“execute 返回时立刻使 JWT 过期”。verify 校验 exp；中间件另对 cancelled / cancellation requested 阻止写入，但不能把这理解成所有 succeeded/failed/timed_out 的旧令牌在认证层一律失效。各业务路由仍可有更严格的 active-run/owner 条件。
- 签名 secret 缺失时，createLocalAgentJwt 返回 null；heartbeat 记录 warning 后仍可传给适配器 undefined。新适配器若必须靠令牌写回，应自己明确失败，而不是向成员派一个无法认证的任务。
- 默认 48 小时足以覆盖 §7.3 最大四小时运行加短暂取消等待，但**实际部署 TTL 未确认**：本次不读取实例秘密或运行配置，不能声称现有实例一定是默认值。也没有现成“长任务自动刷新 JWT”的保证。

### 依据（文件:行号）

- `server/src/agent-auth-jwt.ts:39`、`:51`：secret 缺失和 TTL；`:121` 起：默认 standard scope；`:134`：claims；`:225`：exp 检查；`:238`：实例检查。
- `server/src/services/heartbeat.ts:6604`、`:6608`：legacy + flag 签发；`:6620`：运行秘密登记脱敏；`:6624`：缺令牌只 warning；`:7243`：传给 adapter。
- `server/src/middleware/auth.ts:356`、`:368`、`:373`、`:382`、`:402`、`:433`：JWT 认证和主体恢复。
- `server/src/agent-run-cancellation.ts:6`、`:15`：取消后的写权限撤销与事务内检查。
- `packages/adapter-utils/src/types.ts:514`：supportsLocalAgentJwt 标志；`packages/adapters/codex-local/src/server/execute.ts:973`：token 注入环境。

### 对规格的影响

§5.1 可以确认该标志为 true，前提是新适配器使用 legacy 直接执行分支。§3/§10 明确“按运行签发的、有 TTL 的 agent 凭证”与“一次性/仅当前任务/结束即撤销”的区别。加入实例 TTL 足够的部署前置验证；若不满足，需负责人选择提高 TTL、降低 maxRunSec 或另定刷新设计。本次不改 TTL，不扩展权限，不读取/打印真实令牌。

## Q5：context 中项目、目录字段和本机映射

### 结论

**项目编号可取得，但目录是服务器解析后的路径。映射可以在代理内完成；仅 projectId → 本地根目录还不足以证明工作树、会话、附属项目和 scratch 路径都正确。**

主字段：

- `context.paperclipWorkspace`：cwd、source、mode、strategy、projectId、workspaceId、repoUrl、repoRef、branchName、worktreePath、realization、agentHome。
- `context.paperclipWorkspaces`：主项目的其他工作区提示与引用项目的列表；引用项包括 projectId/workspaceId/cwd/repoUrl/repoRef。不能假定每个历史/备选项都能只凭 cwd 映射到成员目录。
- `context.projectId`：缺失时由 executionWorkspace.projectId 补齐；taskId/issueId 是任务标识，不能代替项目标识。
- `runtime` 不在 context 内，是单独传给 execute 的 `{ sessionId, sessionParams, sessionDisplayId, taskKey }`。sessionParams 会带 cwd；ACP 还会带本地 stateDir/skills 等引用。返回服务器的应是会话引用，不能把本机账号凭据装入 sessionParams。

成员代理应重建本地 ctx，而不是透传服务器 ctx 的路径。需明确主项目 ID 取值及不一致时的行为；把批准的本地目录同时用于 `config.cwd`、`context.paperclipWorkspace.cwd`、工作树/agentHome/scratch 路径与相关环境，以及有必要的 workspace 列表和会话兼容检查。目录缺失应按规格失败或用明确配置的 defaultCwd，不能让库退回代理进程的 process.cwd。

特别注意：现有 Codex CLI 优先使用 `context.paperclipWorkspace.cwd`，之后才是 config.cwd；因此只映射 config.cwd 会继续在服务器路径下运行，甚至在成员电脑新建同名目录。本次没有把生产上下文发到本机进行此类危险试验。

现有服务器会在调用适配器前解析/物化执行工作区；`execution-workspaces` 的 git_worktree rebuild 使用的是服务器可访问的基础目录。它不能自动在成员电脑创建同一工作树。§8.1 的 projectDirs 解决的是目录定位，不是本机并行工作树的自动创建、合并与收集。若本期明确每个 agent 单任务、项目目录预置，需把这一限制写清；否则需要负责人定义本地工作树职责，不能暗中扩展成本期的 changeScope/diff 功能。

### 依据（文件:行号）

- `server/src/services/heartbeat.ts:5137`：paperclipWorkspace 全字段；`:5155`：复数提示；`:5181`：branch pin；`:5210`：补 projectId；`:5292`：独立 runtime；`:7172`：向适配器传递。
- `server/src/services/heartbeat/workspaces.ts:1539`：复数 workspace 列表；`server/src/services/execution-workspaces.ts:2996`、`:3022`：服务器物化/重建工作树。
- `packages/adapters/codex-local/src/server/execute.ts:602`、`:633`、`:638`：目录优先级；`:660`：自动建目录；`:943`：工作区环境；`:1068`：session cwd 兼容性。
- `packages/adapter-utils/src/server-utils.ts:3280`：工作区环境字段；`packages/adapter-utils/src/acpx-engine/execute.ts:1964`：stateDir。
- `packages/adapter-utils/src/types.ts:19`：runtime 契约；Q3 返回值的 CLI/ACP sessionParams 是实际输出证据。

### 对规格的影响

§8.1 增加有依据的字段映射与路径清洗规则，§8.2 明确 runtime/session 本地归属。§6.2 的 context 需有可发送字段约束，至少避免原样携带服务器的路径和无关内部服务地址。是否要求本机工作树自动管理由负责人另定；本次没有实现，也没有改现有 execution-workspaces。

**未确认：**专用服务器的项目路径/物化策略是否允许任务顺利到达新适配器、多仓库任务在成员端的策略、本地工作树和已有服务器 finalize 是否存在兼容冲突。缺 `member_agent` 注册后的集成证据，不能用 Q3 手工构造的小上下文代替。

## Q6：固定版本来源和完整性验证

### 结论

**代码确认了版本钉住的来源和可借鉴的校验层次，但没有现成可直接复用的成员 Windows 自动下载升级实现。仅运行 --version 不证明二进制完整性。**

1. 版本窗口来自 `codex-runtime-compatibility.ts`：稳定版 >=0.149.0 且 <0.161.0。安装钉版来自 `acpx-profiles.json` 中 `@openai/codex` 0.160.0；REMOTE_PROVIDER_PACK_PINS 间接读该 profile，不是另一套独立版本。ACP server 本身另钉 1.6.2。
2. native-session-executor 的一个现有来源是受配置的 `runnerRemoteCodexNpmSpec`：执行 `npm install --prefix ... <spec>`，之后调用 verifyRemoteCodex 检查版本和模型兼容性。npm 的 registry 可配置；这些行**没有规定成员代理必须从哪个固定 URL 下载**，不能把任意 npm spec 当作安全来源白名单。
3. 另一个来源是 controller 上已存在的 `runnerRemoteCodexBinaryPath`，将本地文件传入远端再检查版本。`stageRemoteRunnerFile` 有文件同步或 POSIX base64 路径，不是 Windows 成员安装器。
4. provider-pack 的 manifest 比对、文件/目录 SHA-256 校验是另一层 artifact identity 检查；runnerd 还有与 controller-owned bytes 比对的专门校验。这些不能混写为 verifyRemoteCodex 已对所有独立 Codex 下载做了官方哈希验证。
5. 仓库 lockfile 已有主包和 **Windows 平台包**的 SHA-512 SRI，可作为本期确定校验方式的具体依据。主包 `@openai/codex@0.160.0` 与平台 alias `@openai/codex-win32-x64` → `@openai/codex@0.160.0-win32-x64` 都必须固定，不能只核主包版本。arm64 也有独立条目。
6. 推荐待批准的下载策略：安装包发布时保存允许来源、确切版本、平台/架构及**预先可信**的包完整性值；客户端下载到临时目录，核 SRI/哈希、路径和架构，再核 --version，然后在空闲时替换。只对刚下载的文件自己算一个哈希，并不能证明来源可信。具体可信清单分发、更新授权、解包约束和替换失败策略尚未确定，不在阶段 0 实现。

### 依据（文件:行号）

- `server/src/services/native-runtime/codex-runtime-compatibility.ts:8`、`:24`、`:33`：窗口和稳定版本检查。
- `packages/paperclip-runner/acpx-profiles.json:53`：Codex profile；`server/src/services/native-runtime/native-session-executor.ts:9879`：REMOTE_PROVIDER_PACK_PINS。
- `server/src/services/native-runtime/native-session-executor.ts:11558`：npm spec；`:11672`：Codex --version 校验；`:11982`：显式二进制来源；`:12030`：npm 安装；`:12048`：安装后复验。
- 同文件 `:10187`：传文件；`:11715`、`:11735`：provider-pack manifest 与哈希；`:11855`：runnerd 对 controller-owned bytes 的校验。
- `pnpm-lock.yaml:8`：Codex ACP 依赖覆盖；`:3267`：主包 integrity；`:3296`：Windows arm64；`:3302`：Windows x64；`:11336`：平台 optionalDependency alias。
- `packages/paperclip-runner/package.json:177`：Codex 安装钉版；Q3 的 0.160.0 --version 及原生 exe 执行输出。

### 对规格的影响

§8.3 保留窗口和钉版，补上明确的可信下载/校验清单契约，区分“版本兼容”与“文件身份”。阶段 6 不能只比对版本号，也不能称为已经支持自动升级。不得为此修改 Runner / PRP 或现有适配器。

**未确认：**当前官方 registry/发布站上的对应包实时可下载性、Windows 安装包来源验证与签名、对下载包实际执行 SRI 校验、自动升级/回滚、干净机器安装。缺发布产物和阶段 6 验收；本次没有联网下载包或安装新版本。

## 阶段 0 回报

阶段：0。  
改动文件：仅 `doc/plans/2026-10-26-member-agent-phase0-findings.md`；Q3 脚本与原始输出位于临时目录，全文附后。  
运行命令与输出：见附录；Q3 三次隔离协议执行 exit 0，一次裸 Node 加载 exit 1；所有输出均保留。  
验收项：Q1–Q6 均有结论、源码位置和规格影响；集成行为未确认项已分别列出。Q3 完成库调用/真实本地进程探针，不冒充真实模型/服务器验收。  
偏离本规格的地方：未实现任何阶段 1 及以后内容；没有改选路线、改产品代码或扩大允许修改范围。Q3 为隔离凭据采用回环 fixture，并明确限制。  
遇到但未解决的问题：开头七项；真实任务、会话续接、取消进程树、frp 和安装包仍未验收。  
下一阶段需要负责人确认的事项：裁定开头七项，特别是引擎、协议/历史交接与认证抽取范围；确认前停留在阶段 0。

一句话：**路线 A 的本地库调用可行，但规格需补齐引擎与固定启动入口、取消/事件/用量/会话协议、历史和工具交付、本机地址与路径映射、JWT 边界及可信下载校验，并解决认证复用的改动白名单冲突。**

## 附录：Q3 脚本、命令与完整输出

临时根目录：`C:\Users\11580\AppData\Local\Temp\paperclip-member-agent-phase0-20261025`。完整脚本与原始输出也嵌入下文，避免临时目录清理后证据丢失。

脚本逐次补充了 ACP 的临时 stateDir/关闭 warm handle、钉版 exe 参数与进程级 API URL 对照；这些变动只在临时目录。最终脚本支持重现四种命令。最早 CLI 输出对应未显式设置 ACP 专用 stateDir 的版本，该配置不参与 CLI 分支；默认 ACP 输出对应尚未加入 cli-pinned 分支、但其他逻辑相同的版本。未把多次输出拼装成一次运行。

### 最终探针脚本全文

```typescript
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

// No server process, database, personal login, or real Paperclip token.
const root = path.dirname(fileURLToPath(import.meta.url));
const repo = 'D:/paperclip';
const req = createRequire(path.join(repo, 'server/package.json'));
const executable = process.argv[3] ?? 'C:/Users/11580/AppData/Roaming/npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe';
const lane = process.argv[2] ?? 'cli';
const runRoot = path.join(root, `run-${lane}`);
const cwd = path.join(runRoot, 'workspace');
const codexHome = path.join(runRoot, 'codex-home');
await fs.mkdir(cwd, { recursive: true });
await fs.mkdir(codexHome, { recursive: true });
// Prevent credential vend and inherited provider settings; these changes are process-local.
for (const name of Object.keys(process.env)) {
  if (/^(PAPERCLIP_|OPENAI_|CODEX_|ANTHROPIC_)/.test(name)) delete process.env[name];
}
process.env.CODEX_HOME = codexHome;
process.env.PAPERCLIP_CODEX_AUTH_CACHE = 'false';
process.env.PAPERCLIP_HOME = path.join(runRoot, 'paperclip-home');
process.env.TMP = runRoot;
process.env.TEMP = runRoot;
process.env.TMPDIR = runRoot;
console.log('NODE', process.version, 'PLATFORM', process.platform, process.arch, 'ENGINE', lane);
const version = spawnSync(executable, ['--version'], { encoding: 'utf8', env: process.env });
console.log('CODEX_VERSION', JSON.stringify({ status: version.status, stdout: version.stdout, stderr: version.stderr }));
const rootModule = await import(pathToFileURL(req.resolve('@paperclipai/adapter-codex-local')).href);
console.log('ROOT_EXPORT_EXECUTE', typeof rootModule.execute);
const adapter = await import(pathToFileURL(req.resolve('@paperclipai/adapter-codex-local/server')).href);
console.log('SERVER_EXPORT_EXECUTE', typeof adapter.execute);
assert.equal(typeof adapter.execute, 'function');

let requests = 0;
const http = createServer(async (request, response) => {
  let raw = '';
  for await (const chunk of request) raw += chunk;
  requests++;
  console.log('LOOPBACK_REQUEST', request.method, request.url);
  if (request.method !== 'POST' || !request.url?.endsWith('/responses')) {
    response.writeHead(404); response.end('not found'); return;
  }
  const body = JSON.parse(raw);
  console.log('PROVIDER_INPUT', JSON.stringify({ model: body.model, stream: body.stream, tools: body.tools?.map((t: any) => t.name ?? t.type) }));
  const message = { id: 'msg_q3', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Q3_LOCAL_EXECUTE_OK', annotations: [] }] };
  const result = { id: `resp_q3_${requests}`, object: 'response', created_at: 1700000000, status: 'completed', model: body.model, output: [message], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 } } };
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const event = (type: string, data: any) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  event('response.created', { response: { ...result, status: 'in_progress', output: [] } });
  event('response.output_item.added', { output_index: 0, item: { ...message, status: 'in_progress', content: [] } });
  event('response.content_part.added', { item_id: message.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
  event('response.output_text.delta', { item_id: message.id, output_index: 0, content_index: 0, delta: 'Q3_LOCAL_EXECUTE_OK' });
  event('response.output_text.done', { item_id: message.id, output_index: 0, content_index: 0, text: 'Q3_LOCAL_EXECUTE_OK' });
  event('response.output_item.done', { output_index: 0, item: message });
  event('response.completed', { response: result });
  response.end();
});
await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
const port = (http.address() as any).port;
if (lane === 'cli-pinned') process.env.PAPERCLIP_API_URL = `http://127.0.0.1:${port}`;
await fs.writeFile(path.join(codexHome, 'config.toml'), [
  'model = "gpt-5.4"', 'model_provider = "phase0"',
  '[model_providers.phase0]', 'name = "Phase 0 loopback fixture"',
  `base_url = "http://127.0.0.1:${port}/v1"`, 'wire_api = "responses"',
  'requires_openai_auth = false', 'request_max_retries = 0', 'stream_max_retries = 0',
].join('\n'));
const counters: Record<string, number> = {};
const count = (name: string) => { counters[name] = (counters[name] ?? 0) + 1; };
const hardDeadline = setTimeout(() => { console.error('PROBE_HARD_DEADLINE'); process.exit(124); }, 90000);
try {
  const result = await adapter.execute({
    runId: '00000000-0000-4000-8000-000000000003',
    agent: { id: '00000000-0000-4000-8000-000000000001', companyId: '00000000-0000-4000-8000-000000000002', name: 'phase0-fixture', adapterType: 'codex_local', adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null },
    config: { ...(lane === 'default' ? {} : { engine: 'cli' }), stateDir: path.join(runRoot, 'acpx-state'), warmHandleIdleMs: 0, command: executable, cwd, model: 'gpt-5.4', timeoutSec: 30, graceSec: 2, managedAiConnection: true, promptTemplate: 'Reply exactly Q3_LOCAL_EXECUTE_OK. Do not use tools or make network requests.', extraArgs: ['--skip-git-repo-check'], env: { CODEX_HOME: codexHome, OPENAI_API_KEY: '', PAPERCLIP_API_URL: `http://127.0.0.1:${port}`, PAPERCLIP_CODEX_AUTH_CACHE: 'false' } },
    context: { paperclipWorkspace: { cwd, source: 'project_primary', projectId: 'phase0-project' } },
    executionTarget: { kind: 'local' },
    getFreshSessionHandoff: async () => { count('getFreshSessionHandoff'); return null; },
    onLog: async (stream: string, chunk: string) => { count('onLog'); console.log('ADAPTER_LOG', stream, JSON.stringify(chunk)); },
    onMeta: async (meta: any) => { count('onMeta'); console.log('ADAPTER_META', JSON.stringify(meta)); },
    onEvent: async (event: any) => { count('onEvent'); console.log('ADAPTER_EVENT', JSON.stringify(event)); },
    onUsage: async (usage: any) => { count('onUsage'); console.log('ADAPTER_USAGE', JSON.stringify(usage)); },
    onSpawn: async (meta: any) => { count('onSpawn'); console.log('LOCAL_SPAWN', JSON.stringify(meta)); },
    onDispatch: () => count('onDispatch'),
    onCancellationReady: async () => { count('onCancellationReady'); },
    onProviderStopped: async () => { count('onProviderStopped'); },
    signal: new AbortController().signal,
  });
  console.log('RESULT', JSON.stringify(result));
  console.log('CALLBACK_COUNTS', JSON.stringify(counters));
  console.log('LOOPBACK_REQUEST_COUNT', requests);
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.match(JSON.stringify(result), /Q3_LOCAL_EXECUTE_OK/);
  assert.ok(requests > 0);
  assert.ok(counters.onSpawn > 0);
  console.log('ASSERTIONS_PASS standalone import + native local process + loopback provider + parsed result');
} catch (error: any) {
  console.error('PROBE_FAILED', error?.stack ?? String(error));
  process.exitCode = 1;
} finally {
  clearTimeout(hardDeadline);
  http.closeAllConnections();
  await new Promise<void>(resolve => http.close(() => resolve()));
}

```

### 第一次：显式 CLI，已安装的 0.163.0

命令（PowerShell；stdout/stderr 合并捕获，末尾单独记录实际子进程退出码）：

```powershell
$env:TSX_DISABLE_CACHE='1'
node 'D:\paperclip\server\node_modules\tsx\dist\cli.mjs' 'C:\Users\11580\AppData\Local\Temp\paperclip-member-agent-phase0-20261025\q3-probe.mts' cli
```

完整输出：

```text
NODE v24.18.0 PLATFORM win32 x64 ENGINE cli
CODEX_VERSION {"status":0,"stdout":"codex-cli 0.163.0\n","stderr":"WARNING: proceeding, even though we could not create PATH aliases: Refusing to create helper binaries under temporary dir \"C:\\\\Users\\\\11580\\\\AppData\\\\Local\\\\Temp\\\\paperclip-member-agent-phase0-20261025\\\\run-cli\\\\\" (codex_home: AbsolutePathBuf(\"C:\\\\Users\\\\11580\\\\AppData\\\\Local\\\\Temp\\\\paperclip-member-agent-phase0-20261025\\\\run-cli\\\\codex-home\"))\n"}
ROOT_EXPORT_EXECUTE undefined
SERVER_EXPORT_EXECUTE function
ADAPTER_LOG stdout "[paperclip] Injected Codex skill \"complain\" into C:\\Users\\11580\\AppData\\Local\\Temp\\paperclip-member-agent-phase0-20261025\\run-cli\\codex-home\\skills\n"
ADAPTER_LOG stdout "[paperclip] Injected Codex skill \"paperclip\" into C:\\Users\\11580\\AppData\\Local\\Temp\\paperclip-member-agent-phase0-20261025\\run-cli\\codex-home\\skills\n"
ADAPTER_LOG stdout "[paperclip] Injected Codex skill \"suggestion-box\" into C:\\Users\\11580\\AppData\\Local\\Temp\\paperclip-member-agent-phase0-20261025\\run-cli\\codex-home\\skills\n"
ADAPTER_META {"adapterType":"codex_local","command":"C:/Users/11580/AppData/Roaming/npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe","cwd":"C:\\Users\\11580\\AppData\\Local\\Temp\\paperclip-member-agent-phase0-20261025\\run-cli\\workspace","commandNotes":["Codex exec automatically applies repo-scoped AGENTS.md instructions from the current workspace; Paperclip does not currently suppress that discovery."],"commandArgs":["exec","--json","--dangerously-bypass-approvals-and-sandbox","--model","gpt-5.4","--skip-git-repo-check","-"],"env":{"PAPERCLIP_AGENT_ID":"00000000-0000-4000-8000-000000000001","PAPERCLIP_COMPANY_ID":"00000000-0000-4000-8000-000000000002","PAPERCLIP_API_URL":"http://localhost:3100","PAPERCLIP_RUN_ID":"00000000-0000-4000-8000-000000000003","PAPERCLIP_WORKSPACE_CWD":"C:\\Users\\11580\\AppData\\Local\\Temp\\paperclip-member-agent-phase0-20261025\\run-cli\\workspace","PAPERCLIP_WORKSPACE_SOURCE":"project_primary","CODEX_HOME":"C:\\Users\\11580\\AppData\\Local\\Temp\\paperclip-member-agent-phase0-20261025\\run-cli\\codex-home","OPENAI_API_KEY":"***REDACTED***","PAPERCLIP_CODEX_AUTH_CACHE":"false","PAPERCLIP_RESOLVED_COMMAND":"C:/Users/11580/AppData/Roaming/npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe"},"prompt":"Reply exactly Q3_LOCAL_EXECUTE_OK. Do not use tools or make network requests.","promptMetrics":{"promptChars":77,"instructionsChars":0,"bootstrapPromptChars":0,"wakePromptChars":0,"sessionHandoffChars":0,"taskContextChars":0,"heartbeatPromptChars":77},"context":{"paperclipWorkspace":{"cwd":"C:\\Users\\11580\\AppData\\Local\\Temp\\paperclip-member-agent-phase0-20261025\\run-cli\\workspace","source":"project_primary","projectId":"phase0-project"}}}
LOCAL_SPAWN {"pid":60680,"processGroupId":null,"startedAt":"2026-10-25T07:01:39.028Z"}
ADAPTER_LOG stderr "WARNING: proceeding, even though we could not create PATH aliases: "
ADAPTER_LOG stderr "Refusing to create helper binaries under temporary dir \"C:\\\\Users\\\\11580\\\\AppData\\\\Local\\\\Temp\\\\paperclip-member-agent-phase0-20261025\\\\run-cli\\\\\" (codex_home: AbsolutePathBuf(\"C:\\\\Users\\\\11580\\\\AppData\\\\Local\\\\Temp\\\\paperclip-member-agent-phase0-20261025\\\\run-cli\\\\codex-home\"))\n"
ADAPTER_LOG stderr "2026-10-25T07:01:39.427444Z  WARN codex_models_manager::model_info: Unknown model gpt-5.4 is used. This will use fallback model metadata.\n"
ADAPTER_LOG stderr "2026-10-25T07:01:39.475149Z  WARN codex_core::shell_snapshot: Failed to create shell snapshot for powershell: Shell snapshot not supported yet for PowerShell\n"
ADAPTER_LOG stdout "{\"type\":\"thread.started\",\"thread_id\":\"01a171dd-6dd6-7ab1-a4a4-e6843130550d\"}\n"
ADAPTER_LOG stderr "2026-10-25T07:01:39.601097Z  WARN codex_models_manager::model_info: Unknown model gpt-5.4 is used. This will use fallback model metadata.\n"
ADAPTER_LOG stdout "{\"type\":\"item.completed\",\"item\":{\"id\":\"item_0\",\"type\":\"error\",\"message\":\"Model metadata for `gpt-5.4` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.\"}}\n"
ADAPTER_LOG stderr "2026-10-25T07:01:39.648128Z  WARN codex_core_plugins::manager: failed to warm featured plugin ids cache error=remote featured plugin request to https://chatgpt.com/backend-api/plugins/featured?platform=codex failed with status 401 Unauthorized: {\"detail\":\"Unauthorized\"}\n"
ADAPTER_USAGE {"costStatus":"unpriced","usageBasis":"per_run","provider":"openai","biller":"chatgpt","billingType":"subscription","model":"gpt-5.4","costUsd":null,"complete":false,"attemptId":"f02f4354-9864-47b4-9030-962e34eb1ff6"}
ADAPTER_LOG stdout "{\"type\":\"turn.started\"}\n"
LOOPBACK_REQUEST POST /v1/responses
PROVIDER_INPUT {"model":"gpt-5.4","stream":true,"tools":["exec_command","write_stdin","request_user_input","view_image","multi_agent_v1","get_goal","create_goal","update_goal","web_search"]}
ADAPTER_LOG stdout "{\"type\":\"item.completed\",\"item\":{\"id\":\"item_1\",\"type\":\"agent_message\",\"text\":\"Q3_LOCAL_EXECUTE_OK\"}}\n"
ADAPTER_USAGE {"usage":{"inputTokens":10,"cachedInputTokens":0,"outputTokens":5},"usageBasis":"per_run","provider":"openai","biller":"chatgpt","billingType":"subscription","model":"gpt-5.4","costUsd":null,"complete":true,"attemptId":"f02f4354-9864-47b4-9030-962e34eb1ff6"}
ADAPTER_LOG stdout "{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":10,\"cached_input_tokens\":0,\"cache_write_input_tokens\":0,\"output_tokens\":5,\"reasoning_output_tokens\":0}}\n"
RESULT {"exitCode":0,"signal":null,"timedOut":false,"usageComplete":true,"errorMessage":null,"errorCode":null,"errorFamily":null,"retryNotBefore":null,"usage":{"inputTokens":10,"cachedInputTokens":0,"outputTokens":5},"usageBasis":"per_run","sessionId":"01a171dd-6dd6-7ab1-a4a4-e6843130550d","sessionParams":{"sessionId":"01a171dd-6dd6-7ab1-a4a4-e6843130550d","cwd":"C:\\Users\\11580\\AppData\\Local\\Temp\\paperclip-member-agent-phase0-20261025\\run-cli\\workspace"},"sessionDisplayId":"01a171dd-6dd6-7ab1-a4a4-e6843130550d","provider":"openai","biller":"chatgpt","model":"gpt-5.4","billingType":"subscription","costUsd":null,"resultJson":{"stdout":"{\"type\":\"thread.started\",\"thread_id\":\"01a171dd-6dd6-7ab1-a4a4-e6843130550d\"}\n{\"type\":\"item.completed\",\"item\":{\"id\":\"item_0\",\"type\":\"error\",\"message\":\"Model metadata for `gpt-5.4` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.\"}}\n{\"type\":\"turn.started\"}\n{\"type\":\"item.completed\",\"item\":{\"id\":\"item_1\",\"type\":\"agent_message\",\"text\":\"Q3_LOCAL_EXECUTE_OK\"}}\n{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":10,\"cached_input_tokens\":0,\"cache_write_input_tokens\":0,\"output_tokens\":5,\"reasoning_output_tokens\":0}}\n","stderr":"WARNING: proceeding, even though we could not create PATH aliases: Refusing to create helper binaries under temporary dir \"C:\\\\Users\\\\11580\\\\AppData\\\\Local\\\\Temp\\\\paperclip-member-agent-phase0-20261025\\\\run-cli\\\\\" (codex_home: AbsolutePathBuf(\"C:\\\\Users\\\\11580\\\\AppData\\\\Local\\\\Temp\\\\paperclip-member-agent-phase0-20261025\\\\run-cli\\\\codex-home\"))\n2026-10-25T07:01:39.427444Z  WARN codex_models_manager::model_info: Unknown model gpt-5.4 is used. This will use fallback model metadata.\n2026-10-25T07:01:39.475149Z  WARN codex_core::shell_snapshot: Failed to create shell snapshot for powershell: Shell snapshot not supported yet for PowerShell\n2026-10-25T07:01:39.601097Z  WARN codex_models_manager::model_info: Unknown model gpt-5.4 is used. This will use fallback model metadata.\n2026-10-25T07:01:39.648128Z  WARN codex_core_plugins::manager: failed to warm featured plugin ids cache error=remote featured plugin request to https://chatgpt.com/backend-api/plugins/featured?platform=codex failed with status 401 Unauthorized: {\"detail\":\"Unauthorized\"}\n"},"summary":"Q3_LOCAL_EXECUTE_OK","clearSession":false}
CALLBACK_COUNTS {"onLog":14,"getFreshSessionHandoff":1,"onMeta":1,"onSpawn":1,"onUsage":2,"onProviderStopped":1}
LOOPBACK_REQUEST_COUNT 1
ASSERTIONS_PASS standalone import + native local process + loopback provider + parsed result
EXIT_CODE=0

```

### 第二次：默认 ACP

命令（PowerShell；stdout/stderr 合并捕获，末尾单独记录实际子进程退出码）：

```powershell
$env:TSX_DISABLE_CACHE='1'
node 'D:\paperclip\server\node_modules\tsx\dist\cli.mjs' 'C:\Users\11580\AppData\Local\Temp\paperclip-member-agent-phase0-20261025\q3-probe.mts' default
```

完整输出：

```text
NODE v24.18.0 PLATFORM win32 x64 ENGINE default
CODEX_VERSION {"status":0,"stdout":"codex-cli 0.163.0\n","stderr":"WARNING: proceeding, even though we could not create PATH aliases: Refusing to create helper binaries under temporary dir \"C:\\\\Users\\\\11580\\\\AppData\\\\Local\\\\Temp\\\\paperclip-member-agent-phase0-20261025\\\\run-default\\\\\" (codex_home: AbsolutePathBuf(\"C:\\\\Users\\\\11580\\\\AppData\\\\Local\\\\Temp\\\\paperclip-member-agent-phase0-20261025\\\\run-default\\\\codex-home\"))\n"}
ROOT_EXPORT_EXECUTE undefined
SERVER_EXPORT_EXECUTE function
ADAPTER_EVENT {"eventType":"run.startup.step","stream":"system","level":"info","message":"startup step: workspace.resolve (1ms)","payload":{"step":"workspace.resolve","durationMs":1,"outcome":"ok"}}
ADAPTER_EVENT {"eventType":"run.startup.step","stream":"system","level":"info","message":"startup step: skills.reconcile (2ms)","payload":{"step":"skills.reconcile","durationMs":2,"outcome":"ok"}}
ADAPTER_EVENT {"eventType":"run.startup.step","stream":"system","level":"info","message":"startup step: codex-home.seed (71ms)","payload":{"step":"codex-home.seed","durationMs":71,"outcome":"ok"}}
ADAPTER_LOG stderr "[paperclip] Adapter execution timeout: timeoutSec=30 (configured via adapterConfig.timeoutSec; set adapterConfig.timeoutSec to override).\n"
ADAPTER_EVENT {"eventType":"run.phase.timing","stream":"system","level":"info","message":"run phase: create_runtime (0ms)","payload":{"phase":"create_runtime","durationMs":0,"outcome":"ok"}}
LOCAL_SPAWN {"pid":12932,"processGroupId":null,"startedAt":"2026-10-25T07:02:01.857Z"}
ADAPTER_EVENT {"eventType":"run.startup.step","stream":"system","level":"info","message":"startup step: acp.handshake (985ms)","payload":{"step":"acp.handshake","durationMs":985,"outcome":"ok"}}
ADAPTER_EVENT {"eventType":"run.phase.timing","stream":"system","level":"info","message":"run phase: ensure_session (986ms)","payload":{"phase":"ensure_session","durationMs":986,"outcome":"ok"}}
ADAPTER_EVENT {"eventType":"run.phase.timing","stream":"system","level":"info","message":"run phase: configure_session (0ms)","payload":{"phase":"configure_session","durationMs":0,"outcome":"ok"}}
ADAPTER_LOG stdout "{\"type\":\"acpx.session\",\"agent\":\"codex\",\"sessionId\":\"01a171dd-c8e8-7723-8e0c-a1cca82fc501\",\"acpSessionId\":\"01a171dd-c8e8-7723-8e0c-a1cca82fc501\",\"runtimeSessionName\":\"acpx:v2:eyJuYW1lIjoicGFwZXJjbGlwOjAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMjowMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDE6ZGVmYXVsdDplN2JhMTEwM2RhNWVhM2MxIiwiYWdlbnQiOiJjb2RleCIsImN3ZCI6IkM6XFxVc2Vyc1xcMTE1ODBcXEFwcERhdGFcXExvY2FsXFxUZW1wXFxwYXBlcmNsaXAtbWVtYmVyLWFnZW50LXBoYXNlMC0yMDI2MTAyNVxccnVuLWRlZmF1bHRcXHdvcmtzcGFjZSIsIm1vZGUiOiJwZXJzaXN0ZW50IiwiYWNweFJlY29yZElkIjoicGFwZXJjbGlwOjAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMjowMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDE6ZGVmYXVsdDplN2JhMTEwM2RhNWVhM2MxIiwiYmFja2VuZFNlc3Npb25JZCI6IjAxYTE3MWRkLWM4ZTgtNzcyMy04ZTBjLWExY2NhODJmYzUwMSJ9\",\"mode\":\"persistent\",\"permissionMode\":\"approve-all\",\"model\":\"gpt-5.4\",\"thinkingEffort\":null,\"fastMode\":false}\n"
ADAPTER_META {"adapterType":"codex_local","command":"D:\\paperclip\\packages\\adapters\\codex-local\\node_modules\\.bin\\codex-acp.cmd","cwd":"C:\\Users\\11580\\AppData\\Local\\Temp\\paperclip-member-agent-phase0-20261025\\run-default\\workspace","commandNotes":["ACPX runtime embedded in Paperclip with persistent session mode.","Effective ACPX permission mode: approve-all.","Requested ACPX model: gpt-5.4 (set via CODEX_CONFIG at startup).","Prepared ACPX Codex skill home at C:\\Users\\11580\\AppData\\Local\\Temp\\paperclip-member-agent-phase0-20261025\\run-default\\codex-home\\skills."],"env":{"PAPERCLIP_AGENT_ID":"00000000-0000-4000-8000-000000000001","PAPERCLIP_COMPANY_ID":"00000000-0000-4000-8000-000000000002","PAPERCLIP_API_URL":"http://localhost:3100","PAPERCLIP_RUN_ID":"00000000-0000-4000-8000-000000000003","PAPERCLIP_WORKSPACE_CWD":"C:\\Users\\11580\\AppData\\Local\\Temp\\paperclip-member-agent-phase0-20261025\\run-default\\workspace","PAPERCLIP_WORKSPACE_SOURCE":"project_primary","CODEX_HOME":"C:\\Users\\11580\\AppData\\Local\\Temp\\paperclip-member-agent-phase0-20261025\\run-default\\codex-home","OPENAI_API_KEY":"***REDACTED***","PAPERCLIP_CODEX_AUTH_CACHE":"false","PAPERCLIP_CODEX_ACP_NETWORK_ACCESS":"true","CODEX_CONFIG":"{\"model\":\"gpt-5.4\"}","PAPERCLIP_RESOLVED_COMMAND":"D:\\paperclip\\packages\\adapters\\codex-local\\node_modules\\.bin\\codex-acp.cmd"},"prompt":"Paperclip has materialized selected runtime skills for this ACPX Codex run.\nSkill root for this run: C:\\Users\\11580\\AppData\\Local\\Temp\\paperclip-member-agent-phase0-20261025\\run-default\\codex-home\\skills\nSelected skills: complain, paperclip, suggestion-box\nWhen a task calls for one of these skills, read its SKILL.md from this root and follow it. Resolve referenced scripts and files relative to that skill. Use this run's root even when an earlier turn used a different path.\n\nPaperclip runtime note:\nThe following PAPERCLIP_* environment variables are available in this run: PAPERCLIP_AGENT_ID, PAPERCLIP_API_URL, PAPERCLIP_CODEX_ACP_NETWORK_ACCESS, PAPERCLIP_CODEX_AUTH_CACHE, PAPERCLIP_COMPANY_ID, PAPERCLIP_RUN_ID, PAPERCLIP_WORKSPACE_CWD, PAPERCLIP_WORKSPACE_SOURCE\nDo not assume these variables are missing without checking your shell environment.\n\nReply exactly Q3_LOCAL_EXECUTE_OK. Do not use tools or make network requests.","promptMetrics":{"promptChars":455,"instructionsChars":0,"bootstrapPromptChars":0,"wakePromptChars":0,"sessionHandoffChars":0,"taskContextChars":0,"runtimeNoteChars":376,"heartbeatPromptChars":77},"context":{"paperclipWorkspace":{"cwd":"C:\\Users\\11580\\AppData\\Local\\Temp\\paperclip-member-agent-phase0-20261025\\run-default\\workspace","source":"project_primary","projectId":"phase0-project"}}}
ADAPTER_EVENT {"eventType":"run.phase.timing","stream":"system","level":"info","message":"run phase: prepare_turn (4ms)","payload":{"phase":"prepare_turn","durationMs":4,"outcome":"ok"}}
ADAPTER_LOG stdout "{\"type\":\"acpx.status\",\"text\":\"session updated\",\"tag\":\"session_info_update\"}\n"
ADAPTER_LOG stdout "{\"type\":\"acpx.status\",\"text\":\"session updated\",\"tag\":\"session_info_update\"}\n"
LOOPBACK_REQUEST POST /v1/responses
PROVIDER_INPUT {"model":"gpt-5.4","stream":true,"tools":["exec_command","write_stdin","request_user_input","view_image","multi_agent_v1","get_goal","create_goal","update_goal","web_search"]}
ADAPTER_LOG stdout "{\"type\":\"acpx.text_delta\",\"text\":\"Q3_LOCAL_EXECUTE_OK\",\"channel\":\"output\",\"tag\":\"agent_message_chunk\"}\n"
ADAPTER_USAGE {"provider":"openai","biller":"chatgpt","billingType":"subscription","costUsd":null,"model":"gpt-5.4","usageBasis":"per_run","complete":false}
ADAPTER_LOG stdout "{\"type\":\"acpx.status\",\"text\":\"usage updated: 15/258400\",\"tag\":\"usage_update\",\"used\":15,\"size\":258400}\n"
ADAPTER_LOG stdout "{\"type\":\"acpx.status\",\"text\":\"session updated\",\"tag\":\"session_info_update\"}\n"
ADAPTER_LOG stdout "{\"type\":\"acpx.status\",\"text\":\"session updated\",\"tag\":\"session_info_update\"}\n"
ADAPTER_USAGE {"provider":"openai","biller":"chatgpt","billingType":"subscription","usage":{"inputTokens":10,"outputTokens":5,"cachedInputTokens":0},"costUsd":null,"model":"gpt-5.4","usageBasis":"per_run","complete":true}
ADAPTER_LOG stdout "{\"type\":\"acpx.result\",\"summary\":\"completed\",\"stopReason\":\"end_turn\",\"message\":null}\n"
ADAPTER_EVENT {"eventType":"run.phase.timing","stream":"system","level":"info","message":"run phase: turn (1323ms)","payload":{"phase":"turn","durationMs":1323,"outcome":"ok"}}
ADAPTER_EVENT {"eventType":"run.phase.timing","stream":"system","level":"info","message":"run phase: end_session (123ms)","payload":{"phase":"end_session","durationMs":123,"outcome":"ok"}}
ADAPTER_EVENT {"eventType":"run.phase.timing","stream":"system","level":"info","message":"run phase: settle_reuse (0ms)","payload":{"phase":"settle_reuse","durationMs":0,"outcome":"ok"}}
ADAPTER_EVENT {"eventType":"run.phase.timing","stream":"system","level":"info","message":"run phase: stop_transport (0ms)","payload":{"phase":"stop_transport","durationMs":0,"outcome":"ok"}}
ADAPTER_EVENT {"eventType":"run.phase.timing","stream":"system","level":"info","message":"run phase: sync_back (1ms)","payload":{"phase":"sync_back","durationMs":1,"outcome":"ok"}}
RESULT {"exitCode":0,"signal":null,"timedOut":false,"errorMessage":null,"errorCode":null,"sessionId":"01a171dd-c8e8-7723-8e0c-a1cca82fc501","sessionParams":{"sessionKey":"paperclip:00000000-0000-4000-8000-000000000002:00000000-0000-4000-8000-000000000001:default:e7ba1103da5ea3c1","runtimeSessionName":"acpx:v2:eyJuYW1lIjoicGFwZXJjbGlwOjAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMjowMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDE6ZGVmYXVsdDplN2JhMTEwM2RhNWVhM2MxIiwiYWdlbnQiOiJjb2RleCIsImN3ZCI6IkM6XFxVc2Vyc1xcMTE1ODBcXEFwcERhdGFcXExvY2FsXFxUZW1wXFxwYXBlcmNsaXAtbWVtYmVyLWFnZW50LXBoYXNlMC0yMDI2MTAyNVxccnVuLWRlZmF1bHRcXHdvcmtzcGFjZSIsIm1vZGUiOiJwZXJzaXN0ZW50IiwiYWNweFJlY29yZElkIjoicGFwZXJjbGlwOjAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMjowMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDE6ZGVmYXVsdDplN2JhMTEwM2RhNWVhM2MxIiwiYmFja2VuZFNlc3Npb25JZCI6IjAxYTE3MWRkLWM4ZTgtNzcyMy04ZTBjLWExY2NhODJmYzUwMSJ9","acpxRecordId":"paperclip:00000000-0000-4000-8000-000000000002:00000000-0000-4000-8000-000000000001:default:e7ba1103da5ea3c1","acpSessionId":"01a171dd-c8e8-7723-8e0c-a1cca82fc501","agent":"codex","cwd":"C:\\Users\\11580\\AppData\\Local\\Temp\\paperclip-member-agent-phase0-20261025\\run-default\\workspace","mode":"persistent","stateDir":"C:\\Users\\11580\\AppData\\Local\\Temp\\paperclip-member-agent-phase0-20261025\\run-default\\acpx-state","configFingerprint":"e7ba1103da5ea3c1","mcpFingerprint":"4f53cda18c2baa0c","model":"gpt-5.4","skills":{"mode":"codex","skillSetKey":"2b2dfe865e4829c59079a55ab138d731c62ca9654b615576b067793abe0da65c","desiredSkillNames":["paperclipai/paperclip/paperclip","paperclipai/paperclip/complain","paperclipai/paperclip/suggestion-box"],"selectedSkills":["complain","paperclip","suggestion-box"],"codexHome":"C:\\Users\\11580\\AppData\\Local\\Temp\\paperclip-member-agent-phase0-20261025\\run-default\\codex-home","skillsHome":"C:\\Users\\11580\\AppData\\Local\\Temp\\paperclip-member-agent-phase0-20261025\\run-default\\codex-home\\skills","commandNotes":["Prepared ACPX Codex skill home at C:\\Users\\11580\\AppData\\Local\\Temp\\paperclip-member-agent-phase0-20261025\\run-default\\codex-home\\skills."]},"mcpServers":[]},"sessionDisplayId":"01a171dd-c8e8-7723-8e0c-a1cca82fc501","provider":"openai","biller":"chatgpt","billingType":"subscription","model":"gpt-5.4","usage":{"inputTokens":10,"outputTokens":5,"cachedInputTokens":0},"usageBasis":"per_run","costUsd":null,"usageComplete":true,"resultJson":{"status":"completed","acpObservedEventCount":6,"acpLastEventAgeMs":1025,"acpPendingToolCount":0,"acpToolInventoryComplete":true,"stopReason":"end_turn","permissionMode":"approve-all","mode":"persistent","requestedModel":"gpt-5.4","requestedThinkingEffort":null,"fastMode":false,"usage":{"inputTokens":10,"outputTokens":5,"cachedReadTokens":0,"thoughtTokens":0,"totalTokens":15},"adapterExecutionTimeout":{"timeoutSec":30,"source":"configured"}},"summary":"Q3_LOCAL_EXECUTE_OK","clearSession":false}
CALLBACK_COUNTS {"onCancellationReady":1,"onEvent":13,"onLog":9,"onSpawn":1,"getFreshSessionHandoff":1,"onMeta":1,"onUsage":2,"onProviderStopped":1}
LOOPBACK_REQUEST_COUNT 1
ASSERTIONS_PASS standalone import + native local process + loopback provider + parsed result
EXIT_CODE=0

```

### 第三次：裸 Node 加载失败

命令（PowerShell；stdout/stderr 合并捕获，末尾单独记录实际子进程退出码）：

```powershell
node 'C:\Users\11580\AppData\Local\Temp\paperclip-member-agent-phase0-20261025\q3-probe.mts' cli
```

完整输出：

```text
NODE v24.18.0 PLATFORM win32 x64 ENGINE cli
CODEX_VERSION {"status":0,"stdout":"codex-cli 0.163.0\n","stderr":"WARNING: proceeding, even though we could not create PATH aliases: Refusing to create helper binaries under temporary dir \"C:\\\\Users\\\\11580\\\\AppData\\\\Local\\\\Temp\\\\paperclip-member-agent-phase0-20261025\\\\run-cli\\\\\" (codex_home: AbsolutePathBuf(\"C:\\\\Users\\\\11580\\\\AppData\\\\Local\\\\Temp\\\\paperclip-member-agent-phase0-20261025\\\\run-cli\\\\codex-home\"))\n"}
node:internal/modules/esm/resolve:271
    throw new ERR_MODULE_NOT_FOUND(
          ^

Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'D:\paperclip\packages\adapter-utils\src\session-compaction.js' imported from D:\paperclip\packages\adapter-utils\src\index.ts
    at finalizeResolution (node:internal/modules/esm/resolve:271:11)
    at moduleResolve (node:internal/modules/esm/resolve:865:10)
    at defaultResolve (node:internal/modules/esm/resolve:992:11)
    at #cachedDefaultResolve (node:internal/modules/esm/loader:701:20)
    at #resolveAndMaybeBlockOnLoaderThread (node:internal/modules/esm/loader:721:38)
    at ModuleLoader.resolveSync (node:internal/modules/esm/loader:759:56)
    at #resolve (node:internal/modules/esm/loader:683:17)
    at ModuleLoader.getOrCreateModuleJob (node:internal/modules/esm/loader:603:35)
    at ModuleJob.syncLink (node:internal/modules/esm/module_job:163:33)
    at ModuleJob.link (node:internal/modules/esm/module_job:253:17) {
  code: 'ERR_MODULE_NOT_FOUND',
  url: 'file:///D:/paperclip/packages/adapter-utils/src/session-compaction.js'
}

Node.js v24.18.0
EXIT_CODE=1

```

### 第四次：显式 CLI，固定 0.160.0

命令（PowerShell；stdout/stderr 合并捕获，末尾单独记录实际子进程退出码）：

```powershell
$env:TSX_DISABLE_CACHE='1'
node 'D:\paperclip\server\node_modules\tsx\dist\cli.mjs' 'C:\Users\11580\AppData\Local\Temp\paperclip-member-agent-phase0-20261025\q3-probe.mts' cli-pinned 'D:\paperclip\node_modules\.pnpm\@openai+codex@0.160.0-win32-x64\node_modules\@openai\codex\vendor\x86_64-pc-windows-msvc\bin\codex.exe'
```

完整输出：

```text
NODE v24.18.0 PLATFORM win32 x64 ENGINE cli-pinned
CODEX_VERSION {"status":0,"stdout":"codex-cli 0.160.0\n","stderr":"WARNING: proceeding, even though we could not create PATH aliases: Refusing to create helper binaries under temporary dir \"C:\\\\Users\\\\11580\\\\AppData\\\\Local\\\\Temp\\\\paperclip-member-agent-phase0-20261025\\\\run-cli-pinned\\\\\" (codex_home: AbsolutePathBuf(\"C:\\\\Users\\\\11580\\\\AppData\\\\Local\\\\Temp\\\\paperclip-member-agent-phase0-20261025\\\\run-cli-pinned\\\\codex-home\"))\n"}
ROOT_EXPORT_EXECUTE undefined
SERVER_EXPORT_EXECUTE function
ADAPTER_LOG stdout "[paperclip] Injected Codex skill \"complain\" into C:\\Users\\11580\\AppData\\Local\\Temp\\paperclip-member-agent-phase0-20261025\\run-cli-pinned\\codex-home\\skills\n"
ADAPTER_LOG stdout "[paperclip] Injected Codex skill \"paperclip\" into C:\\Users\\11580\\AppData\\Local\\Temp\\paperclip-member-agent-phase0-20261025\\run-cli-pinned\\codex-home\\skills\n"
ADAPTER_LOG stdout "[paperclip] Injected Codex skill \"suggestion-box\" into C:\\Users\\11580\\AppData\\Local\\Temp\\paperclip-member-agent-phase0-20261025\\run-cli-pinned\\codex-home\\skills\n"
ADAPTER_META {"adapterType":"codex_local","command":"D:\\paperclip\\node_modules\\.pnpm\\@openai+codex@0.160.0-win32-x64\\node_modules\\@openai\\codex\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe","cwd":"C:\\Users\\11580\\AppData\\Local\\Temp\\paperclip-member-agent-phase0-20261025\\run-cli-pinned\\workspace","commandNotes":["Codex exec automatically applies repo-scoped AGENTS.md instructions from the current workspace; Paperclip does not currently suppress that discovery."],"commandArgs":["exec","--json","--dangerously-bypass-approvals-and-sandbox","--model","gpt-5.4","--skip-git-repo-check","-"],"env":{"PAPERCLIP_AGENT_ID":"00000000-0000-4000-8000-000000000001","PAPERCLIP_COMPANY_ID":"00000000-0000-4000-8000-000000000002","PAPERCLIP_API_URL":"http://127.0.0.1:56945","PAPERCLIP_RUN_ID":"00000000-0000-4000-8000-000000000003","PAPERCLIP_WORKSPACE_CWD":"C:\\Users\\11580\\AppData\\Local\\Temp\\paperclip-member-agent-phase0-20261025\\run-cli-pinned\\workspace","PAPERCLIP_WORKSPACE_SOURCE":"project_primary","CODEX_HOME":"C:\\Users\\11580\\AppData\\Local\\Temp\\paperclip-member-agent-phase0-20261025\\run-cli-pinned\\codex-home","OPENAI_API_KEY":"***REDACTED***","PAPERCLIP_CODEX_AUTH_CACHE":"false","PAPERCLIP_RESOLVED_COMMAND":"D:\\paperclip\\node_modules\\.pnpm\\@openai+codex@0.160.0-win32-x64\\node_modules\\@openai\\codex\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe"},"prompt":"Reply exactly Q3_LOCAL_EXECUTE_OK. Do not use tools or make network requests.","promptMetrics":{"promptChars":77,"instructionsChars":0,"bootstrapPromptChars":0,"wakePromptChars":0,"sessionHandoffChars":0,"taskContextChars":0,"heartbeatPromptChars":77},"context":{"paperclipWorkspace":{"cwd":"C:\\Users\\11580\\AppData\\Local\\Temp\\paperclip-member-agent-phase0-20261025\\run-cli-pinned\\workspace","source":"project_primary","projectId":"phase0-project"}}}
LOCAL_SPAWN {"pid":66120,"processGroupId":null,"startedAt":"2026-10-25T07:03:44.541Z"}
ADAPTER_LOG stderr "WARNING: proceeding, even though we could not create PATH aliases: Refusing to create helper binaries under temporary dir \"C:\\\\Users\\\\11580\\\\AppData\\\\Local\\\\Temp\\\\paperclip-member-agent-phase0-20261025\\\\run-cli-pinned\\\\\" (codex_home: AbsolutePathBuf(\"C:\\\\Users\\\\11580\\\\AppData\\\\Local\\\\Temp\\\\paperclip-member-agent-phase0-20261025\\\\run-cli-pinned\\\\codex-home\"))\n"
ADAPTER_LOG stderr "2026-10-25T07:03:44.712124Z  WARN codex_models_manager::model_info: Unknown model gpt-5.4 is used. This will use fallback model metadata.\n"
ADAPTER_LOG stderr "2026-10-25T07:03:44.715406Z  WARN codex_core::shell_snapshot: Failed to create shell snapshot for powershell: Shell snapshot not supported yet for PowerShell\n"
ADAPTER_LOG stdout "{\"type\":\"thread.started\",\"thread_id\":\"01a171df-5746-7680-bb53-1cd2cfa6c924\"}\n"
ADAPTER_LOG stderr "2026-10-25T07:03:44.755450Z  WARN codex_models_manager::model_info: Unknown model gpt-5.4 is used. This will use fallback model metadata.\n"
ADAPTER_LOG stdout "{\"type\":\"item.completed\",\"item\":{\"id\":\"item_0\",\"type\":\"error\",\"message\":\"Model metadata for `gpt-5.4` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.\"}}\n"
ADAPTER_USAGE {"costStatus":"unpriced","usageBasis":"per_run","provider":"openai","biller":"chatgpt","billingType":"subscription","model":"gpt-5.4","costUsd":null,"complete":false,"attemptId":"9eeb868d-ae38-4e34-ada7-0f1a87c94fd1"}
ADAPTER_LOG stdout "{\"type\":\"turn.started\"}\n"
LOOPBACK_REQUEST POST /v1/responses
PROVIDER_INPUT {"model":"gpt-5.4","stream":true,"tools":["exec_command","write_stdin","request_user_input","view_image","multi_agent_v1","get_goal","create_goal","update_goal","web_search"]}
ADAPTER_LOG stdout "{\"type\":\"item.completed\",\"item\":{\"id\":\"item_1\",\"type\":\"agent_message\",\"text\":\"Q3_LOCAL_EXECUTE_OK\"}}\n"
ADAPTER_USAGE {"usage":{"inputTokens":10,"cachedInputTokens":0,"outputTokens":5},"usageBasis":"per_run","provider":"openai","biller":"chatgpt","billingType":"subscription","model":"gpt-5.4","costUsd":null,"complete":true,"attemptId":"9eeb868d-ae38-4e34-ada7-0f1a87c94fd1"}
ADAPTER_LOG stdout "{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":10,\"cached_input_tokens\":0,\"cache_write_input_tokens\":0,\"output_tokens\":5,\"reasoning_output_tokens\":0}}\n"
ADAPTER_LOG stderr "2026-10-25T07:03:44.984997Z  WARN codex_core_plugins::manager: failed to warm featured plugin ids cache error=remote featured plugin request to https://chatgpt.com/backend-api/plugins/featured?platform=codex failed with status 401 Unauthorized: {\"detail\":\"Unauthorized\"}\n"
RESULT {"exitCode":0,"signal":null,"timedOut":false,"usageComplete":true,"errorMessage":null,"errorCode":null,"errorFamily":null,"retryNotBefore":null,"usage":{"inputTokens":10,"cachedInputTokens":0,"outputTokens":5},"usageBasis":"per_run","sessionId":"01a171df-5746-7680-bb53-1cd2cfa6c924","sessionParams":{"sessionId":"01a171df-5746-7680-bb53-1cd2cfa6c924","cwd":"C:\\Users\\11580\\AppData\\Local\\Temp\\paperclip-member-agent-phase0-20261025\\run-cli-pinned\\workspace"},"sessionDisplayId":"01a171df-5746-7680-bb53-1cd2cfa6c924","provider":"openai","biller":"chatgpt","model":"gpt-5.4","billingType":"subscription","costUsd":null,"resultJson":{"stdout":"{\"type\":\"thread.started\",\"thread_id\":\"01a171df-5746-7680-bb53-1cd2cfa6c924\"}\n{\"type\":\"item.completed\",\"item\":{\"id\":\"item_0\",\"type\":\"error\",\"message\":\"Model metadata for `gpt-5.4` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.\"}}\n{\"type\":\"turn.started\"}\n{\"type\":\"item.completed\",\"item\":{\"id\":\"item_1\",\"type\":\"agent_message\",\"text\":\"Q3_LOCAL_EXECUTE_OK\"}}\n{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":10,\"cached_input_tokens\":0,\"cache_write_input_tokens\":0,\"output_tokens\":5,\"reasoning_output_tokens\":0}}\n","stderr":"WARNING: proceeding, even though we could not create PATH aliases: Refusing to create helper binaries under temporary dir \"C:\\\\Users\\\\11580\\\\AppData\\\\Local\\\\Temp\\\\paperclip-member-agent-phase0-20261025\\\\run-cli-pinned\\\\\" (codex_home: AbsolutePathBuf(\"C:\\\\Users\\\\11580\\\\AppData\\\\Local\\\\Temp\\\\paperclip-member-agent-phase0-20261025\\\\run-cli-pinned\\\\codex-home\"))\n2026-10-25T07:03:44.712124Z  WARN codex_models_manager::model_info: Unknown model gpt-5.4 is used. This will use fallback model metadata.\n2026-10-25T07:03:44.715406Z  WARN codex_core::shell_snapshot: Failed to create shell snapshot for powershell: Shell snapshot not supported yet for PowerShell\n2026-10-25T07:03:44.755450Z  WARN codex_models_manager::model_info: Unknown model gpt-5.4 is used. This will use fallback model metadata.\n2026-10-25T07:03:44.984997Z  WARN codex_core_plugins::manager: failed to warm featured plugin ids cache error=remote featured plugin request to https://chatgpt.com/backend-api/plugins/featured?platform=codex failed with status 401 Unauthorized: {\"detail\":\"Unauthorized\"}\n"},"summary":"Q3_LOCAL_EXECUTE_OK","clearSession":false}
CALLBACK_COUNTS {"onLog":13,"getFreshSessionHandoff":1,"onMeta":1,"onSpawn":1,"onUsage":2,"onProviderStopped":1}
LOOPBACK_REQUEST_COUNT 1
ASSERTIONS_PASS standalone import + native local process + loopback provider + parsed result
EXIT_CODE=0

```

### 证据文件完整性

以下 SHA-256 针对临时目录原始文件字节（包括输出文件编码标记），不是下载包的官方完整性证明。

- `q3-probe.mts`：7499 字节；SHA-256 `15df74c2c8501186d1245c8a559d5d2ca0dbfc41fc36963c43c435a281a77d73`。
- `q3-cli-output.txt`：8423 字节；SHA-256 `aa565777d320eca9fe6a71d2491d95fb053aa53d9ade82ea46b65294df1003c1`。
- `q3-default-output.txt`：11726 字节；SHA-256 `7a6d7dfb7716167950c1dd1df3651a237143b7bce1fa390257d0c1144ebbb1cd`。
- `q3-plain-node-output.txt`：1638 字节；SHA-256 `75b1bed1211858ed9ce8fdf2f11c89d8482e612caa0cd7f0dc82cff16b138199`。
- `q3-cli-pinned-output.txt`：8512 字节；SHA-256 `d4f9ac25b3dc514c621a213af5ae28e9deb88488dc377de0ddcd33dd5e3cca27`。

## 工具交付差异清单

核对日期：2026-10-25。用途：实现规格 §12 的阶段 1 前置只读核对。已重读规格开头“阶段 0 之后的负责人决定”以及本文件原有结论；其中已经裁定的引擎、模型、历史交接、目录和认证方案，以更新后的负责人决定为准，不再把本文件前文的待裁定建议当作仍未作出的决定。本节只追加差异与依据，不实施阶段 1，不修改规格或产品代码。

### 先明确比较边界

这里比较的是：现有 `codex_local` 将 Paperclip 提供的 MCP 服务接入模型，与新规格决定的成员代理仅使用环境变量、普通 HTTP 接口和运行技能。**没有原生工具按钮，不等于没有后端业务能力；设置 `runtimeToolDelivery: "environment"` 也不会自动把所有 MCP 服务转换成 REST 工具或注入环境。**

代码链路分三路，不能混作一个开关：

- `codex_local` 声明 `native_mcp`；heartbeat 仅在这个值下，把连接发现/授权服务作为“Paperclip connections”加入 MCP 列表。依据：`server/src/adapters/registry.ts:330`、`:332`，`server/src/services/heartbeat.ts:7133`、`:7135`。
- “Paperclip projects”服务与已分配的第三方工具也会加入 `runtimeMcp`，但这两路的构造**不以 native_mcp 为条件**；是否让成员模型看到它们，还要由新适配器/代理交付。依据：`server/src/services/heartbeat.ts:7128`、`:7143`、`:7147`、`:7186`。
- 显式配置的 managed gateway 还有单独通路，当前只支持 `codex_local`。CLI 引擎读取 `ctx.runtimeMcp.getServers()` 和 managed gateway 快照，将 URL、认证头写入专属 CODEX_HOME 的 MCP 配置。依据：`server/src/services/heartbeat/run-preparation.ts:1274`、`:1391`、`:1402`，`packages/adapters/codex-local/src/server/execute.ts:759`、`:764`、`:768`，`packages/adapters/codex-local/src/server/codex-home.ts:314`、`:317`、`:326`。

因此，下列“少了什么”指新方案**不交付这些 MCP 服务**时的差异，不声称改一个枚举值就必定丢失全部服务。本节仅核对代码，没有查询任何公司实例的连接配置、令牌或实时工具列表，也没有向外部服务发起调用。

### 逐项核对

#### 1. 原生工具发现、参数 schema 与直接调用入口

- **代码位置：**`packages/adapters/codex-local/src/server/execute.ts:759`、`:768` 交付 MCP 服务；`packages/adapters/codex-local/src/server/codex-home.ts:317` 写入模型可连接的配置；`server/src/routes/connection-intents.ts:89`、`:94` 返回工具定义；`server/src/routes/project-tools.ts:18`、`:19` 返回项目工具定义；`server/src/routes/tool-gateway.ts:113`、`:128` 将外部工具的名称、说明、参数 schema 作为 tools/list 返回。
- **没有它时少做什么：**模型不能直接选择这些已声明的 Paperclip/连接工具，而需要先读技能，再用本地 shell/Node 自行拼 HTTP 请求、解析响应；参数发现和出错处理的便利性降低。这是调用形式差异，没有证据表明 MCP 因此给予模型更高权限。
- **普通接口能否替代：**业务操作可由下面各项的接口替代；普通 REST 本身不会把名称/schema 自动注册成 Codex 的原生工具。仅 environment 无法提供同样的工具发现体验。

#### 2. `connections_search`：发现可用应用、服务和连接方式

- **代码位置：**`server/src/services/connection-tool-definitions.ts:3`、`:5` 定义工具；`server/src/routes/connection-intents.ts:104` 调用 search；`packages/shared/src/connection-intent-guidance.ts:17` 描述按服务名/能力查找及返回 instruction 的用途。
- **没有它时少做什么：**不能直接用模型原生工具搜索现有连接、安装/开启状态及候选接入方式，容易只知道任务 API，不知道需要的外部应用如何接入。
- **普通接口能否替代：****有**，`POST /runtime-tools/connections/search`，见 `server/src/routes/connection-intents.ts:130`。但它使用专用 runtime-tools token，验证位置 `server/src/routes/connection-intents.ts:26`、`:27`；不能用普通 `PAPERCLIP_API_KEY` 运行 JWT 冒充。URL 以 `createAdapterRuntimeToolAccess` 返回的完整地址为准，见 `server/src/services/heartbeat/run-preparation.ts:1263`、`:1265`。成员协议是否额外交付该 token/URL，**未确认**：当前 `job.start` 未明确包含这份能力包。

#### 3. `connection_request`：创建真实的连接设置/授权申请卡

- **代码位置：**`server/src/services/connection-tool-definitions.ts:14`、`:15` 定义工具；`server/src/routes/connection-intents.ts:110` 调用 request；`packages/shared/src/connection-intent-guidance.ts:19` 说明创建真实 setup / Grant access 卡及人工批准边界。
- **没有它时少做什么：**不能直接用模型原生工具向正确的人申请开启连接、指定 connectionId/toolNames，或继续既有 provider-choice 流程。普通评论里写“请授权”不能替代真实卡片，也不授予权限。
- **普通接口能否替代：****有**，`POST /runtime-tools/connections/request`，见 `server/src/routes/connection-intents.ts:134`；与上一项一样需要专用 token，不能只靠运行 JWT。environment 的标准变量构造器确实存在：`packages/adapter-utils/src/server-utils.ts:29`、`:34`、`:37`、`:39`；但新适配器必须明确交付这些值，枚举声明本身不完成交付。没有该能力包时，这项服务接入申请能力在成员运行中不可用。

#### 4. `list_projects`：分页发现已有项目

- **代码位置：**`server/src/services/project-tools.ts:6`、`:7` 选择工具；`:24`、`:31` 构造分页项目查询；`server/src/routes/project-tools.ts:18` 启用此组工具并按 workMode 过滤。
- **没有它时少做什么：**少了可直接选择的“列项目”工具，不能在一次结构化工具调用里获得受权限限制的项目摘要及分页结果；不等于不能查项目。
- **普通接口能否替代：****有**，`GET /api/companies/{companyId}/projects?view=summary&limit=...&cursor=...`；普通路由 `server/src/routes/projects.ts:300`，工具本身正是调用普通 API，见 `server/src/services/project-tools.ts:25`、`:32`、`:51`。

#### 5. `list_project_repositories`：列出获准使用的仓库

- **代码位置：**`server/src/services/project-tools.ts:6`、`:30`；`packages/paperclip-runner/src/catalog/semantic-action-catalog.ts:483`、`:485` 描述稳定仓库 ID 与授权发现。
- **没有它时少做什么：**少了直接获取授权仓库列表的工具入口，创建项目时需要自行查接口，不能凭记忆猜 repositoryId。这不是成员本机代码同步或 Git 上传能力。
- **普通接口能否替代：****有**，`GET /api/companies/{companyId}/project-repositories`，路由 `server/src/routes/projects.ts:278`；返回范围仍依赖当前责任人/连接授权，不因使用 REST 而扩大。

#### 6. `create_project`：创建 Paperclip 项目

- **代码位置：**`server/src/services/project-tools.ts:12`、`:36`、`:37` 校验请求；`packages/paperclip-runner/src/catalog/semantic-action-catalog.ts:490`、`:492` 描述创建项目及登记已有仓库；`server/src/routes/project-tools.ts:22` 限制不可用模式。
- **没有它时少做什么：**少了结构化创建项目的工具入口，需自行提交符合 API schema 的 JSON、保存幂等键并处理失败。此工具不负责新建远端 GitHub 仓库。
- **普通接口能否替代：****有**，`POST /api/companies/{companyId}/projects`，`server/src/routes/projects.ts:345`；工具包装器也是调用同一路径，见 `server/src/services/project-tools.ts:25`、`:36`、`:51`。是否允许该 agent/工作模式创建仍由普通鉴权和业务规则决定。

#### 7. `create_task`：创建和交接后续任务

- **代码位置：**`server/src/services/project-tools.ts:9` 只额外放出 create_task / set_task_title 两个任务工具；`:38` 至 `:48` 映射 assignee、parent、blockers、initialPlan 与幂等键；`packages/paperclip-runner/src/catalog/semantic-action-catalog.ts:509` 为工具描述。
- **没有它时少做什么：**少了自动将这些参数转换为普通任务创建请求的便利入口；需要自己维护父子关系、依赖、负责人和幂等，不能只写评论让别人自动开工。
- **普通接口能否替代：****有**，`POST /api/companies/{companyId}/issues`；实际路径和请求字段见 `server/src/services/project-tools.ts:40`、`:41`，技能中的普通接口流程见 `skills/paperclip/SKILL.md:267`。REST 请求应遵守当前模式和分派权限；无需为此新增 member_agent 专用任务创建 API。

#### 8. `set_task_title`：修改当前任务标题

- **代码位置：**`server/src/services/project-tools.ts:9`、`:27`、`:28`、`:29`、`:52`；工具使用已认证运行的当前 issueId，不由模型随意指定其他任务。
- **没有它时少做什么：**少了一个直接给当前任务命名的工具，需自己从任务上下文取 issueId、提交 schema 并处理响应。
- **普通接口能否替代：****有**，`PUT /api/issues/{issueId}/title`，路由 `server/src/routes/issues.ts:13484`。模型仍可通过普通接口完成临时标题更新；不需要 native_mcp 才能命名。

#### 9. 已分配的第三方工具：动态名称和动态参数 schema

- **代码位置：**`server/src/services/heartbeat/run-preparation.ts:915` 获取有效 profile；`:988` 筛选已安装、启用且允许的连接；`:998` 涵盖 MCP remote、local stdio、Browser Use、获准的 GitHub bot 和 Speko 连接；`:1004` 取允许的具体工具；`:1205` 签发绑定运行的网关 token；`:1220` 返回 MCP 服务。具体 tools/list 与 tools/call 在 `server/src/routes/tool-gateway.ts:113`、`:128`、`:183`。
- **没有它时少做什么：**模型不会自动看到这些连接提供的搜索、读取或写入操作，也不会自动获得相应网关地址及凭证。连接“已经安装”不等于成员本机 Codex 已经能调用。**某公司实际有哪些动态工具名称、哪些能成功调用：未确认**，缺该公司/agent 的有效安装、profile、授权和实时 tools/list；源码无法给出所有自定义 MCP 服务的固定全量名称。
- **普通接口能否替代：****部分可以，且有通用受管调用通路。**先以运行主体调用 `POST /api/tool-gateway/sessions` 获取会话，再用 `X-Paperclip-Tool-Gateway-Token` 调用 `GET /api/tool-gateway/tools` 和 `POST /api/tool-gateway/tools/call`；位置分别为 `server/src/routes/tool-gateway.ts:475`、`:488`、`:497`、`:508`、`:557`、`:571`。服务继续使用 `listToolsForContext` 做过滤，见 `server/src/services/tool-gateway.ts:9000`、`:9006`。但这不是自动送达，也未证明普通 session 与某个 named gateway 的 profile 范围完全相同；必须以实际返回目录和策略为准。直接取第三方原始密钥、绕过网关/审批不算替代方案。

#### 10. 显式 managed gateway 的自动选择、绑定和配置

- **代码位置：**`server/src/services/heartbeat/run-preparation.ts:1274`、`:1402` 目前只给 codex_local 构建 managed 配置；`:1491` 按当前 agent/project/issue 选网关；`:1513` 要求连接已安装；`:1527` 签发绑定 heartbeat_run 的 token；`:1541` 输出网关地址/凭证。CLI 合并和写配置见 `packages/adapters/codex-local/src/server/execute.ts:764`、`:768`。
- **没有它时少做什么：**成员代理不会仅因服务器上已配置某个 managed gateway，就获得该网关的模型工具入口与限定访问范围。`member_agent` 也不在当前支持集合中；把整个服务器 context/config 透传不能视为合法复用。
- **普通接口能否替代：**部分业务工具可走第 9 项 session API，但**不能确认它等价复刻每个显式 named gateway 的配置/权限范围**。现有 named gateway 的精确调用入口仍是 MCP：`server/src/routes/tool-gateway.ts:247`、`:250`、`:467`、`:471`。本期若不交付 MCP，应明确放弃自动 managed gateway 体验，不能宣称已经接入；也无需为主流程自动扩大代码修改范围。

#### 11. `paperclip_list_resources`：发现已完整授权连接的 MCP 资源

- **代码位置：**`server/src/routes/tool-gateway.ts:132` 定义此工具；`:163`、`:164` 转换为 `resources/list`；`server/src/services/tool-gateway.ts:5475`、`:5476`、`:5477` 先检查动作权限，再列 fully-assigned 连接资源。
- **没有它时少做什么：**若某网关确实授予 resources 权限且上游支持，模型少了跨该网关发现资源 URI 的入口。普通任务 documents/attachments 的读取不属于这一项。
- **普通接口能否替代：****未找到等价的通用 REST 资源列举接口**；源码中已有的入口是上述 MCP 方法，而不是 `/tool-gateway/tools`。上游是否另有普通 API：**未确认**，需要具体连接资料。
- **重要限定：**本次发现自动签发给运行的 assignment/managed gateway token 都只允许 `tools/list`、`tools/call`，见 `server/src/services/heartbeat/run-preparation.ts:1214`、`:1536`；资源方法还要额外通过 `server/src/services/tool-gateway.ts:2063`、`:5475` 的动作检查。因此它被 tools/list 列出，不证明当前自动交付的 codex_local 运行就能成功使用；不能把一项未获权能力记成确定损失。

#### 12. `paperclip_read_resource`：读取 MCP 资源内容

- **代码位置：**`server/src/routes/tool-gateway.ts:137` 定义工具；`:165` 转换为 `resources/read`；`server/src/services/tool-gateway.ts:5527`、`:5532` 校验资源 handle 归属；`:5543`、`:5546` 转发上游读取。
- **没有它时少做什么：**在具备相应资源权限的情况下，模型不能直接读取网关返回的 MCP 资源内容；不是失去 Paperclip 任务报告读取接口。
- **普通接口能否替代：****未找到等价通用 REST 接口**；特定资源是否另有 HTTP 下载地址，**未确认**。与第 11 项相同，默认运行网关 token 的动作范围并未授予 resources/read，不能认定所有现有 codex_local 运行均可用。

#### 13. `paperclip_list_prompts`：发现连接提供的 MCP 提示词模板

- **代码位置：**`server/src/routes/tool-gateway.ts:142` 定义工具；`:166` 转换为 `prompts/list`；`server/src/services/tool-gateway.ts:5502`、`:5505` 查询已完整授权连接的提示词。
- **没有它时少做什么：**若网关权限与上游支持具备，模型不能直接发现服务提供的提示词模板。它与本机 AGENTS.md、Paperclip runtime skill、任务历史摘要是不同来源，不能混算。
- **普通接口能否替代：****未找到等价通用 REST 接口**；具体上游是否另有接口，**未确认**。同样受默认运行 token 只允许 tools/list、tools/call 的限制，列出不等于可用。

#### 14. `paperclip_get_prompt`：按参数取回 MCP 提示词

- **代码位置：**`server/src/routes/tool-gateway.ts:147` 定义工具；`:167` 转换为 `prompts/get`；`server/src/services/tool-gateway.ts:5527`、`:5530`、`:5545` 校验提示词 handle 并传入 arguments。
- **没有它时少做什么：**若已获权，模型不能直接获取并展开该上游提示词。不会因此失去服务器下发的任务说明或负责人已经决定必须提供的历史摘要。
- **普通接口能否替代：****未找到等价通用 REST 接口**；特定上游替代方式，**未确认**。仍须应用第 11 项的 token 限定，不能把它表述成现有自动交付必然具备的能力。

#### 15. 第三方调用的受管凭证、策略检查与调用审计通路

- **代码位置：**`server/src/services/heartbeat/run-preparation.ts:1205`、`:1210`、`:1214` 签发限动作、限运行的网关 token；`server/src/services/tool-gateway.ts:6981` 校验 named gateway bearer；`:7163` 绑定 company/agent/run/issue/profile；`:9906` 检查 tools/call 权限。普通 REST 调用同样进入 executeTool，见 `server/src/routes/tool-gateway.ts:589`；工具发现审计见 `server/src/services/tool-gateway.ts:9007`，执行审计见 `:10608`。
- **没有它时少做什么：**如果只给普通运行 JWT 和任务 API，而既不交付网关也不创建 REST gateway session，就没有这条调用外部连接的完整通路；模型不能把“知道服务名称”视为能调用。也少了直接在模型工具层发起连接操作的呈现。
- **普通接口能否替代：**第 9 项的受管 REST 通路仍能走服务端策略和审计，**审计、公司隔离、审批不是 native_mcp 独占能力**。不能声称换成 REST 就没有治理；但绕过 Paperclip 直接调用服务，不会自动拥有同一条调用记录与策略边界。两种呈现在 Codex/看板上的逐条工具轨迹是否完全一致，**未确认**，缺成员代理实际运行记录；本次没有做 UI 或集成验收。

### environment 方案容易漏掉的交付前提

1. **枚举不是实现。** heartbeat 会把 `runtimeTools` 传给适配器（`server/src/services/heartbeat.ts:7187`），但必须由适配器交付；`buildRuntimeToolsEnv` 才会生成对应的端点、token、到期时间与说明（`packages/adapter-utils/src/server-utils.ts:29`）。现有 process 适配器显式调用这个 helper（`server/src/adapters/process/execute.ts:48`），不能据此推断新增 member_agent 会自动获得相同行为。
2. **不能混用凭证。** 任务 API 使用本次运行的 agent JWT；connections search/request 使用 runtime-tools token；普通 gateway 调用使用 session token；named gateway 使用其专用 bearer。代码入口分别见 `server/src/middleware/auth.ts:356`、`server/src/routes/connection-intents.ts:26`、`server/src/routes/tool-gateway.ts:39`、`server/src/services/tool-gateway.ts:6981`。只交付一个 authToken 并不等价于交付全部连接能力。
3. **令牌时长也不是同一设置。** 普通连接工具 token 是一小时（`server/src/runtime-tools-token.ts:15`、`:60`），自动 assignment/managed gateway token 也设置一小时（`server/src/services/heartbeat/run-preparation.ts:1215`、`:1524`）。负责人决定的运行 JWT 至少八小时不会自动延长这些 token。这不阻碍任务主流程，但会限制长任务中的外部连接操作；本节没有新增续期方案。
4. **技能不会因为缺原生工具失去业务 API。** 当前技能已经描述 Bearer 认证、运行编号、checkout、写状态、文档及评审流程（`skills/paperclip/SKILL.md:22`、`:30`、`:120`、`:228`、`:362`）。成员代理应确保技能内容和执行 HTTP 的本机能力可用；不是要求成员手动写回。

### 哪些不能误记为 native_mcp 的损失

- **不要把 Paperclip Runner 全部语义工具列为 codex_local 的 MCP 工具。** 项目路由只挑出三个项目工具，加 create_task 和 set_task_title，再按模式过滤（`server/src/services/project-tools.ts:6`、`:9`、`:10`，`server/src/routes/project-tools.ts:18`）。因此 get_task_context、write_document、finish_task 等整个 Runner 工具集并未通过这条路全部交给 codex_local；本节不把未交付的工具当成迁移损失。
- **本机读写文件、运行命令/测试、Codex 自带工具不是 Paperclip 的 native_mcp 授权。** CLI 引擎仍由 `buildCodexExecArgs` 和本地进程执行路径启动（`packages/adapters/codex-local/src/server/execute.ts:1225`、`:1343`）。它们是否受本机权限和具体 CLI 配置限制，需本机验收；不能因为不交付 Paperclip MCP 就说这些基本编程能力消失。
- **历史摘要、session 续接、取消与用量回传不是 MCP 工具目录。** ctx 契约分别包含 context/runtime、signal、onUsage 等（`packages/adapter-utils/src/types.ts:237`、`:243`、`:256`、`:275`）；负责人已单独规定这些路径。本节不将它们算成 native_mcp 独占能力，也不因选 environment 就承诺已经实现。

### 主流程逐步核对

以下均指在**有效的运行 JWT、可达的服务器地址、正确任务/运行编号、本机 HTTP 执行能力、技能已交付，且既有权限/模式允许**的前提下，由智能体自动调用接口；不需要让真人手工回报。

1. **领任务与读上下文：有普通接口。** `GET /api/companies/{companyId}/issues`、`GET /api/issues/{issueId}`、`GET /api/issues/{issueId}/heartbeat-context` 和 `POST /api/issues/{issueId}/checkout`，依据 `server/src/routes/issues.ts:8265`、`:9241`、`:8907`、`:15830`；checkout 只能以当前 agent 身份领取，见 `:15855`。如果本次运行的 harness 明确已经 checkout，按技能避免重复领取，见 `skills/paperclip/SKILL.md:120`。没有 native_mcp 不是领取障碍。
2. **改状态：有普通接口。** `PATCH /api/issues/{issueId}`，依据 `server/src/routes/issues.ts:13514`、`:13515`；技能有同一路径的调用说明，见 `skills/paperclip/SKILL.md:228`、`:244`。仍受当前执行所有权、依赖、暂停、评审等规则限制。
3. **写评论：有普通接口。** `POST /api/issues/{issueId}/comments`，依据 `server/src/routes/issues.ts:18092`、`:18093`；运行归属使用签名 JWT 和 `X-Paperclip-Run-Id`，依据 `server/src/middleware/auth.ts:382`、`:433` 及 `skills/paperclip/SKILL.md:30`。缺 MCP 不改变作者身份。
4. **交报告：有普通接口。** `PUT /api/issues/{issueId}/documents/{key}`，依据 `server/src/routes/issues.ts:10656`、`:10657`、`:10668`；`report` 文档的请求体、revision-safe 更新和确认保存方式见 `skills/paperclip/references/issue-documents.md:18`、`:21`、`:33`。下载文件可用附件接口 `server/src/routes/issues.ts:19243`、`:19244`，产物登记可用 work-products 接口 `:11226`、`:11227`。本期代码同步由成员负责，报告不是自动上传源码；报告应按负责人决定写本机分支、改动文件及测试结果。
5. **提交评审：有普通接口，但不能只改状态空等。** 可按已有策略交给有效评审参与人/人类，或先用 `POST /api/issues/{issueId}/interactions` 建立真实的 `request_confirmation` 等待路径，再用 PATCH 提交 `in_review` 并绑定 `reviewInteractionId`。依据 `server/src/routes/issues.ts:16633`、`:16634`、`:14167`；无真实路径会被拒绝，见 `:4677`、`:4678`；绑定说明见 `skills/paperclip/SKILL.md:362`。这与审批通过是两件事：environment 不会绕过评审规则，也不需要 native_mcp 才能发起评审。

本次只执行源码和文档读取及本文件追加，未调用任何业务写接口，未运行 commit/push，未新增脚本、测试文件或署名。**成员代理下的主流程端到端成功仍未确认**，缺后续阶段的真实任务、运行编号、接口读回和审计证据；当前结论是接口能力可满足，不是宣称该新适配器已经可用。

**一句话结论：environment 方式能满足“领任务、改状态、写评论、交报告、提交评审”这条主流程，前提是正确交付运行凭证、地址、技能与真实评审路径；它不等价于自动提供 codex_local 的原生 MCP 连接、工具发现和外部服务调用体验。**
