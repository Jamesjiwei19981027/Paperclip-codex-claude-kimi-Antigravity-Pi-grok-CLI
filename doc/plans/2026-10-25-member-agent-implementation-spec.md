# 成员本机智能体（member_agent）实现规格

日期：2026-10-25  
性质：交给执行者（含 Codex）照做的规格。上一份是可行性说明：[2026-10-25-member-local-agent-feasibility.md](2026-10-25-member-local-agent-feasibility.md)。  
状态：未开始实现。本文所有"代码里是这样"的陈述都来自 2026-10-25 的只读核对，标"待验证"的不是事实，必须先验证。

## 0. 怎么用这份规格

1. 按第 11 节的阶段顺序做，**上一阶段的验收证据没交，不进入下一阶段**。
2. 第 12 节的待验证问题（Q1–Q6）必须在阶段 0 先回答。答案和本文假设不一致时，**停下来回报，不要自行改方案**。
3. 本文与 `AGENTS.md`、`doc/SPEC-implementation.md` 冲突时，以那两份为准，并回报冲突。
4. 任何"我觉得这样更好"的偏离，先写成一段说明回报，等确认后再做。

## 1. 目标与非目标

### 目标

团队每个成员的 Codex 智能体受同一个 Paperclip 服务器统一调度：负责人派任务 → 服务器唤醒 → 成员电脑上的 Codex 自动干活 → 评论、报告、状态由智能体自己写回 → 看板上运行状态准确。和现在 `codex_local` 的使用体验一致，成员不需要手动回复。

### 约束（来自负责人，不可改）

1. 每个成员用自己的 Codex 账号和额度，账号凭据不上传服务器；
2. 智能体要在成员本机运行（要操作本机设备、模拟器、本地软件）；
3. 多数成员在局域网，少数通过 frp 访问；
4. 成员本机 Codex 版本不一致且会自动更新，不能依赖它；
5. 暂不处理断网、关机、休眠。但**不能因此让运行无限挂住**，见 7.3。

### 阶段 0 之后的负责人决定（2026-10-25，优先于本文其他处的旧表述）

1. **引擎**：成员代理内部固定使用 `engine: "cli"`，Codex 可执行文件固定为 `codex.exe`（Windows 原生程序），不使用默认的 ACP 引擎，因为它会经过 `.cmd` 中转；
2. **不指定模型**：服务器不下发模型名，使用成员本机工具自己的默认设置；每个人的模型和 token 用法自己决定；
3. **不绑死 Codex**：协议和配置按"可换工具"设计，启动哪个工具是成员本机代理自己的选择，服务器不管。第一版只实现 Codex，之后加 Claude Code、CodeBuddy 不需要改服务器。固定版本只对 Codex 生效；
4. **代码同步不在本功能范围**：智能体在成员本机项目目录里写代码、跑测试；成员负责把代码同步到服务器上负责人规定的代码目录（服务器侧一个设置项 `memberAgent.codeSyncDir`，仅用于在任务说明和交付报告里提示，不由智能体上传）；真实设备调试由成员本人做。智能体交报告时必须写明：本机分支名、改动文件、测试命令与结果；
5. **每个智能体同一时间只做一个任务，项目目录由成员预先配置**，不做本机工作树自动管理；
6. **历史与工具**：`job.start` 附带一份有长度上限的历史摘要。**没有历史属于正常情况**（全新任务；与任务无关的唤醒；生成函数在无历史时返回空），此时发空摘要并继续派发；只有生成摘要时**抛出错误**才失败（2026-10-25 阶段 1 核对修正，原写法会让新任务首次运行必然失败）。摘要超长时保留结尾（最新内容），不得从结尾截断；工具通过普通接口与技能提供（`runtimeToolDelivery: "environment"`）。差异清单已由阶段 1 前置核对给出（findings 文档"工具交付差异清单"，15 项），结论：领任务、改状态、写评论、交报告、提交评审这条主流程不受影响。据此补充三条硬要求：
   - **必须交付 `ctx.runtimeTools`**：`job.start` 带上其端点、令牌、到期时间，代理用 `buildRuntimeToolsEnv`（`packages/adapter-utils/src/server-utils.ts:29`）同样的变量名注入 Codex 环境。参照 `server/src/adapters/process/execute.ts:48`。不做这一条，连接搜索、连接申请在成员运行中就不可用；
   - 上面这些工具令牌有效期只有 1 小时（`run-preparation.ts:1215`、`:1524`，`runtime-tools-token.ts:15`），超过 1 小时的长任务里外部连接操作可能失效，本期**接受**这个限制，不做续期，写进使用说明；
   - 本期**明确放弃**：Codex 的原生工具发现、MCP 资源与提示词（`paperclip_list_resources` 等，REST 无等价接口）、显式 managed gateway 的自动配置（`member_agent` 不在其支持集合内）。文档里不得宣称这些已接入；
   - 评审：提交评审必须走真实路径（先建 `request_confirmation` 交互再 PATCH `in_review`，或按已有策略交给有效评审人），报告里不得只改状态；
7. **令牌**：不做自动续期；服务器启动时检查运行令牌有效期不低于 8 小时，签名密钥缺失时适配器明确失败；令牌每次运行重新签发，到期不需要重启服务或重新授权；
8. **版本**：Codex 目标版本放在服务器一个设置项（`memberAgent.pinnedCodexVersion`，默认 `0.160.0`），经 `hello.ack` 下发；本期由成员手动安装，自动升级放阶段 6；
9. **认证复用**：把 `live-events-ws.ts` 中"按智能体 Key 校验"的部分抽成共用函数，新连接只认请求头 `Authorization: Bearer`，不认网址里的令牌。这是对改动白名单的**唯一批准的例外**（见第 5 节）。

10. **阶段 1 补充裁定（2026-10-25，针对 `2026-10-25-member-agent-phase1-preflight-and-handoff.md` 的三个问题）**：
    - **允许同步更新"固定名单"类测试**：`server/src/adapters/registry.test.ts` 加入允许改动清单，只补 `member_agent → environment` 的预期值；若 `adapter-registry.test.ts` 或其他测试里也有同类固定名单，同样只补这一项预期，并在回报里逐个列出。**不得跳过、删除断言或隐藏适配器**；
    - **两个设置项本阶段只用默认值**：新建 `server/src/adapters/member-agent/settings.ts`，里面只有 `pinnedCodexVersion = "0.160.0"` 和 `codeSyncDir = ""` 两个常量，是**唯一**存放处。不使用环境变量，不新增配置文件，不改 `instance.ts`、`instance-settings.ts`、`config.ts`。"可保存的设置"留到阶段 6 另行批准涉及的文件；
    - **`testEnvironment` 本阶段不扩展共享上下文**：缺少具体智能体身份时，返回 `warn`，文字为"无法确认具体成员智能体是否在线"，不得因为公司里有别的成员在线就返回通过。给 `AdapterEnvironmentTestContext` 增加 `agentId` 留到后续阶段；
    - **typecheck 的验收口径**：基线中 `pnpm -r typecheck` 因两处既有环境问题（Windows 脚本 shell、`check-runner-workflow-traceability.mjs` 的路径）失败，**不是本次改动造成，也不要去修**。阶段 1 改为在被改动的包里直接运行 `tsc --noEmit`（至少 `server`，改了 `packages/shared` 或 `ui` 则也跑它们），对比改动前后的错误清单，要求**新增错误为 0**；
    - **3100 端口的服务不得重启**，不得向正在运行的业务派发或取消任务。

### 非目标（本期不做，做了算偏离）

- 不修改 `codex_local`、`claude_local`、`process`、`http`、`openclaw_gateway` 等任何现有适配器的代码；
- 不做文件范围声明（`changeScope`）、diff 校验；
- 不做断线重连后的事件重放、不做运行恢复；
- 不做 Windows 以外的代理安装包（Mac/Linux 成员本期不管）；
- 不改 `paperclip_runner` 及其 PRP 协议；
- 不动 `packages/shared/src/telemetry/`（见 2.5）。

## 2. 硬性规则

2.1 **直接适配器边界**：新增适配器不得在其他适配器里加分支或导入。唯一允许修改共享位置的是第 5 节列出的文件。

2.2 **公司隔离**：所有按智能体查找连接、运行的代码都必须带公司编号校验；一个公司的代理不能收到另一个公司的任务。

2.3 **令牌**：服务器把运行令牌发给代理，**不得写入日志、数据库、错误信息**；日志里只能出现令牌前 4 位加省略号。

2.4 **认证**：代理连接用智能体 API Key，放在 `Authorization: Bearer` 头里，**禁止放进 URL 查询参数**（frp 和反向代理会记录 URL）。

2.5 **三条数据路径**（`AGENTS.md` 第 5.7 条）：不得新增遥测事件，不得改 `packages/shared/src/telemetry/` 下任何文件，不得改 `paperclip-telemetry.ts`。运行日志写入走现有的 `onLog`/`onEvent`，不新建表。

2.6 **不加新表**：本期不改数据库结构。在线状态只放内存。若发现必须加表，停下回报。

2.7 **不静默失败**：任何分支（离线、协议错误、超时、取消）都必须返回明确的 `errorCode` 和人能读懂的 `errorMessage`，并通过 `onLog("stderr", ...)` 写入运行日志。

2.8 **Windows 注意事项**（负责人的环境）：
- npm 安装的 CLI 在 Windows 上是 `.cmd` 垫片，Node 的 `spawn` 不经过 cmd.exe 时找不到或无法执行。代理启动 Codex 必须直接使用 `codex.exe`，或用 `node <codex 入口 js>`，**不得依赖 `.cmd`**；
- 向 Paperclip 接口发送含中文的内容，必须用 UTF-8 编码的 JSON（Node 的 `fetch`），不得用命令行内联拼接；
- 路径一律用 `path` 模块处理，不手写分隔符。

2.9 **git 与署名**：不运行 `git commit`、`git push`，除非负责人明确说"提交"。提交信息和仓库文件里不加任何 AI 署名行。

## 3. 术语

| 词 | 含义 |
|---|---|
| 运行（run） | 服务器唤醒智能体时创建的一次执行记录，有 `runId` |
| 运行令牌 | `AdapterExecutionContext.authToken`，本次运行的短期令牌 |
| 智能体 Key | 智能体的长期 API Key，存在 `agent_api_keys` 表（哈希） |
| 代理 | 成员电脑上常驻的小程序，本文的 `member-agent` |
| 任务包 | 服务器推给代理的一次运行所需的全部信息 |
| 适配器类型 | 新增的 `member_agent` |

## 4. 架构与数据流

```text
成员电脑                                           服务器
┌────────────────────────────┐   wss://…/api/member-agent/v1/connect
│ member-agent（常驻）          │ ─────────────────────────────▶ ┌────────────────────────┐
│  ├ 固定版本 Codex（自带目录）    │   Authorization: Bearer <智能体 Key>  │ member-agent-ws         │
│  ├ 该成员的 CODEX_HOME        │ ◀──────────────── job.start ── │  连接表：agentId → socket  │
│  └ 本机项目目录映射            │ ── job.log / job.result ─────▶ │          ▲             │
└────────────────────────────┘                                 │ member_agent 适配器      │
                                                               │  execute(): 推任务、等结果 │
                                                               └────────────────────────┘
```

一次运行的完整流程：

1. 代理启动，用智能体 Key 建立 WebSocket，发 `hello`；服务器校验后记入连接表，回 `hello.ack`；
2. 负责人派任务，服务器按现有机制唤醒智能体，创建运行，调用 `member_agent` 适配器的 `execute(ctx)`；
3. `execute` 在连接表里找该智能体的连接。**找不到就立刻返回失败（`member_agent_offline`）**，不等待；
4. 找到则发 `job.start`，随即调用 `ctx.onDispatch()`；
5. 代理收到后在本机启动 Codex，环境变量里放运行令牌和运行编号，Codex 照常通过现有 Paperclip 接口领任务、改状态、写评论；
6. 代理把 Codex 的输出分块发 `job.log`，把结束信息发 `job.result`；
7. 适配器把 `job.log` 转给 `ctx.onLog`，收到 `job.result` 就转换并返回 `AdapterExecutionResult`，运行结束；
8. 操作员取消时 `ctx.signal` 触发，适配器发 `job.cancel`，代理终止 Codex，回 `job.result`（`cancelled`）。

## 5. 服务器侧改动清单（逐文件）

**只允许改下面这些文件。** 需要改清单之外的文件时，先回报。

| 文件 | 改动 |
|---|---|
| `server/src/adapters/member-agent/index.ts`（新） | 导出 `memberAgentAdapter: ServerAdapterModule`，字段见 5.1 |
| `server/src/adapters/member-agent/execute.ts`（新） | `execute(ctx)`，逻辑见第 4、7 节 |
| `server/src/adapters/member-agent/test.ts`（新） | `testEnvironment`：只检查该智能体当前是否在线，返回 `pass/warn/fail` |
| `server/src/adapters/member-agent/*.test.ts`（新） | 单元测试，见第 11 节各阶段 |
| `server/src/realtime/member-agent-ws.ts`（新） | WebSocket 服务、连接表、`hello` 校验、心跳检测、消息分发 |
| `server/src/adapters/member-agent/settings.ts`（新） | 两个常量，见决定 10 |
| `server/src/adapters/registry.test.ts` 及同类固定名单测试 | 只补 `member_agent → environment` 预期，见决定 10 |
| `server/src/realtime/agent-key-auth.ts`（新） | 抽出"按智能体 Key 校验"的共用函数（只读请求头 Bearer，不读查询参数），含未撤销检查与最后使用时间更新 |
| `server/src/realtime/live-events-ws.ts` | **唯一批准的改动**：把原有 Key 校验改为调用上面的共用函数。行为必须与改前一致，原有测试全部保持通过；注意该文件原来接受网址里的 `token`，为保持兼容，这个行为留在原文件里，**不得**进入共用函数 |
| `server/src/index.ts` | 在 `setupLiveEventsWebSocketServer`（约 987 行）旁边调用 `setupMemberAgentWebSocketServer`，传入同样的 `db` 和部署模式选项 |
| `server/src/adapters/registry.ts` | 在 `registerBuiltInAdapters` 的数组里加入 `memberAgentAdapter` |
| `server/src/adapters/builtin-adapter-types.ts` | 加入 `"member_agent"` |
| `packages/shared/src/constants.ts` | `AGENT_ADAPTER_TYPES` 加入 `"member_agent"`（该类型 `AgentAdapterType` 本身允许任意字符串，此处只为下拉可选） |
| `ui/src/adapters/adapter-display-registry.ts` | 加显示名称和图标，参照现有最简单的条目 |
| `doc/` | 本规格与实际实现保持同步 |

### 5.1 适配器模块字段

对照 `ServerAdapterModule`（`packages/adapter-utils/src/types.ts` 第 503 行起）：

```ts
{
  type: "member_agent",
  runtimeToolDelivery: "environment",   // 注意：codex_local 实际是 "native_mcp"，两者有能力差异，见决定 6
  execute,
  testEnvironment,
  models: [],                           // 模型由成员本机决定，服务器不管理、不下发
  supportsLocalAgentJwt: true,          // 已确认（Q4）：表示由心跳签发并注入运行令牌，不要求进程在服务器本机
  supportsInstructionsBundle: false,    // 本期不做指令包下发
  agentConfigurationDoc: "...",         // 写清楚 config 字段，见第 9 节
}
```

**不要**照抄 `openclaw_gateway` 的设备密钥生成（`routes/agents.ts` 的 `ensureGatewayDeviceKey`）和 `routes/access.ts` 里 26 处 `openclaw_gateway` 引用，那些是网关专用的入职流程，本期不需要。

### 5.2 不要做的事

- 不复制 `openclaw-gateway` 适配器的 WebSocket 客户端，方向相反（它是服务器去连别人）；
- 不使用 `runner-prp-ws.ts` 里的 `/api/runner/v1/connect/` 路径，那是 Paperclip Runner 专用；
- 不把任务包存数据库。

## 6. 协议（v1）

传输：WebSocket，路径 `/api/member-agent/v1/connect`，每帧一条 JSON（UTF-8 文本帧），单帧上限 256 KB，超出则拒绝并断开。

通用字段：每条消息必须有 `type`（字符串）和 `v`（固定 `1`）。**未知 `type` 一律忽略并记录一条警告，未知 `v` 直接断开**。

### 6.1 代理 → 服务器

| type | 字段 | 说明 |
|---|---|---|
| `hello` | `agentVersion`、`codexVersion`、`platform`（`win32`/`darwin`/`linux`）、`hostname` | 连接后第一条，10 秒内必须发，否则断开 |
| `heartbeat` | `ts` | 每 15 秒一次 |
| `job.accepted` | `jobId` | 收到 `job.start` 后立即回，表示已开始处理 |
| `job.log` | `jobId`、`seq`（从 1 递增）、`stream`（`stdout`/`stderr`）、`chunk` | Codex 输出，单条 `chunk` 上限 32 KB |
| `job.meta` | `jobId`、`meta`（对应 `AdapterInvocationMeta`） | 可选，用于看板显示命令与版本 |
| `job.event` | `jobId`、`seq`、`event`（对应 `AdapterRuntimeEvent`） | 运行事件，写入运行日志，**不是遥测** |
| `job.usage` | `jobId`、`usage`（对应 `AdapterUsageCheckpoint`，含 `complete`、`attemptId`、`usageBasis`、provider/biller/billingType） | 可选；不得只传 token 数 |
| `job.result` | `jobId`、`exitCode`、`signal`、`timedOut`、`errorMessage?`、`errorCode?`、`errorFamily?`、`retryNotBefore?`、`summary?`、`sessionId?`、`sessionDisplayId?`、`sessionParams?`、`clearSession?`、`usageComplete?`、`usageBasis?`、计费属性、`resultJson?` | 结束，只能发一次。字段与 `AdapterExecutionResult`（`adapter-utils/src/types.ts:102`）逐一对照，服务器按白名单校验；成员端的本机进程号只作诊断信息，**不得**传给服务器的 `onSpawn` |

### 6.2 服务器 → 代理

| type | 字段 | 说明 |
|---|---|---|
| `hello.ack` | `heartbeatSec`（默认 15）、`maxRunSec`（默认 3600）、`pinnedCodexVersion?` | 校验通过 |
| `hello.reject` | `code`、`message` | 校验失败，随后服务器断开 |
| `job.start` | `jobId`（= `runId`）、`companyId`、`agent`（`id`、`name`）、`authToken`、`context`、`config`、`runtime`（会话续接参数）、`runtimeTools`（端点、令牌、到期时间；缺失则为空）、`handoffMarkdown`（有长度上限的历史摘要） | 任务包。不得原样序列化整个 `ctx`：`agentIdentity` 含服务器私钥，`startupTraceContext`、`stopRemoteStartup` 等含函数，都不能发 |
| `job.cancel` | `jobId`、`graceSec` | 操作员取消 |
| `ping` | `ts` | 可选 |

**`job.start.config` 只传白名单字段**（第 9 节列出的），不传整份适配器配置。

### 6.3 序号与幂等

- `job.log.seq` 单调递增；服务器丢弃 `seq` 不大于已处理值的重复帧；
- `job.result` 只认第一条，之后的忽略；
- 本期不做断线重放，断线处理见 7.3。

## 7. 服务器行为细则

### 7.1 `hello` 校验（`member-agent-ws.ts`）

1. 取 `Authorization: Bearer <key>`，没有或格式不对 → 拒绝 `401`；
2. 对 key 取 SHA-256，在 `agent_api_keys` 里查，要求未撤销（实现方式见决定 9：调用从 `live-events-ws.ts` 第 214–228 行抽出的共用函数 `agent-key-auth.ts`，**不得复制一份不同的校验逻辑，不得读取网址里的 token**）；
3. 查出的智能体必须：存在、未暂停、未终止、`adapterType === "member_agent"`，否则 `hello.reject`；
4. 同一智能体已有连接时：**拒绝新连接**（`hello.reject`，`code: "already_connected"`），不要踢旧的，避免两台电脑抢同一个智能体；
5. 通过后写入连接表 `Map<agentId, Connection>`，连接对象含 `companyId`、`connectedAt`、`lastHeartbeatAt`、`currentJobId`。

### 7.2 `execute(ctx)` 逻辑

按顺序：

1. 取 `ctx.agent.id` 在连接表里找；找不到 → 写 stderr 日志"该成员智能体当前不在线"，返回 `{ exitCode: 1, errorCode: "member_agent_offline", ... }`；
2. 连接已有 `currentJobId` → 返回 `member_agent_busy`（一个智能体同时只跑一个任务）；
3. 先调用 `ctx.onCancellationReady?.()`（服务器只有在适配器调用它之后，才会注册可等待的运行取消控制；只监听 `ctx.signal` 不够），再发 `job.start`，设置 `currentJobId`；调用 `ctx.onDispatch?.()`。令牌缺失（`ctx.authToken` 为空）时不发任务，直接返回 `member_agent_no_token`；
4. 等 `job.accepted`，**5 秒内没收到** → 返回 `member_agent_not_accepted`；
5. 之后循环处理 `job.log`→`ctx.onLog`、`job.meta`→`ctx.onMeta`、`job.usage`→`ctx.onUsage`；
6. 收到 `job.result` → 转为 `AdapterExecutionResult` 返回；
7. `ctx.signal` 触发 → 发 `job.cancel`，再等 `graceSec + 10` 秒的 `job.result`，仍没有则返回 `cancelled` 并写日志；
8. 无论哪个出口，`finally` 里清掉 `currentJobId`。

### 7.3 断线与超时（不做恢复，但不许挂住）

- **心跳超时**：45 秒（3 个周期）没收到心跳或任何消息 → 连接视为断开；
- 断开时若有 `currentJobId` → `execute` 立即返回 `member_agent_disconnected`，运行标记失败；
- **总时长上限**：`maxRunSec`（默认 3600，可在 config 覆盖，上限 14400）到点 → 发 `job.cancel`，再按 7.2 第 7 步处理，返回 `timedOut: true`；
- 这些是"不挂住"的底线，不是恢复机制。断线后的任务由现有的失败重试/唤醒机制处理，本期不改。

## 8. 代理（成员端）规格

新包：`packages/member-agent/`，包名 `@paperclipai/member-agent`，提供命令 `paperclip-member-agent`。**不得导入 `server/`、`packages/db/`**；与 Paperclip 的交互只通过 WebSocket 与 HTTP 接口。

### 8.1 配置文件（用户目录下 JSON，`%APPDATA%\paperclip-member-agent\config.json`）

```json
{
  "serverUrl": "https://paperclip.example.com",
  "agentKey": "…",
  "codexHome": "C:\\Users\\张三\\.paperclip-agent\\codex-home",
  "codexExecutable": "C:\\Users\\张三\\.paperclip-agent\\codex\\codex.exe",
  "projectDirs": { "<projectId>": "D:\\work\\app" },
  "defaultCwd": "D:\\work"
}
```

- `agentKey` 文件权限收紧到当前用户；日志里**永不打印**；
- `projectDirs`：服务器给的是项目编号（`context.paperclipWorkspace.projectId`，缺失时看 `context.projectId`），本机目录由成员配置；
- **路径重建规则（阶段 0 Q5 实测）**：Codex 适配器优先使用 `context.paperclipWorkspace.cwd`，其次才是 `config.cwd`，所以**只改 `config.cwd` 会仍在服务器路径下运行，甚至在成员电脑新建同名目录**。代理必须用本机目录同时覆盖：`config.cwd`、`context.paperclipWorkspace.cwd`、`worktreePath`、`agentHome`、`paperclipWorkspaces` 列表里的路径，并丢弃其他服务器路径；`runtime.sessionParams` 里若带 cwd，也要换成本机路径；
- **接口地址**：必须由代理自己进程的环境变量 `PAPERCLIP_API_URL` 设置（等于代理连接用的 `serverUrl`）。实测只写在 `config.env` 里无效，子进程拿到的仍是 `http://localhost:3100`；
- 找不到项目目录且没有 `defaultCwd` → 回 `job.result`，`errorCode: "member_agent_cwd_unresolved"`，不要用代理自己的目录。

### 8.2 启动 Codex

两条路线，**由阶段 0 的 Q3 结果决定用哪条**：

- **路线 A（已由阶段 0 Q3 验证可行，采用）**：从 `@paperclipai/adapter-codex-local/server` 子路径（包根的 `execute` 是 undefined）导入，配置里显式 `engine: "cli"`，`command` 指向固定的 `codex.exe`；开发期用 tsx 加载，发布包的加载方式待阶段 6 确认。把它当库，用本地执行目标调用它的 `execute()`，传入根据任务包重建的 `AdapterExecutionContext`。这样提示词、技能注入、会话续接、日志格式与服务器上的 `codex_local` 完全一致。函数型字段（`onLog`、`onMeta`、`onEvent`、`onUsage`、`onSpawn`、`onDispatch`、`signal`）由代理在本地实现并转发为 6.1 的消息；`getFreshSessionHandoff`、`onCancellationReady` 等不能直接转发的，按 Q2 结论处理；
- **路线 B（备选）**：代理自己拼 `codex exec` 参数，参考 `codex-args.ts`，自行实现提示词。**只有路线 A 验证不通时才用**，并要在文档里写明与 `codex_local` 的行为差异。

无论哪条路线：

- 环境变量必须与 `codex_local` 完全一致，具体列表以 `packages/adapters/codex-local/src/server/execute.ts` 约 960–1000 行附近设置的为准，**照抄，不要凭记忆写**；其中 `PAPERCLIP_API_KEY` 取任务包的 `authToken`，`PAPERCLIP_RUN_ID` 取 `jobId`，接口地址取代理自己连接用的 `serverUrl`；
- `CODEX_HOME` 用 8.1 里成员专属目录，**不得**指向 `%USERPROFILE%\.codex`；
- 子进程树要整体终止（取消时），Windows 用 `taskkill /T /F`，不能只杀父进程；
- 同一时刻只运行一个任务。

### 8.3 版本固定

- `hello.ack.pinnedCodexVersion` 给出目标版本；代理比对自带 Codex 的版本，不一致则下载指定版本到自己的目录并替换，**替换前不接新任务**；
- 兼容范围参照 `doc/architecture/paperclip-runner-compatibility.md`："稳定版 `>=0.149.0 <0.161.0`，安装钉版 `0.160.0`"。代理不得在此范围外运行；
- 下载来源与校验方式本期待定（Q6），阶段 0 先不做，阶段 6 才实现。

### 8.4 登录

首次由成员在本机执行 `paperclip-member-agent login`，内部调用 Codex 的设备登录流程，凭据只写入 8.1 的 `codexHome`。可参考 `packages/adapters/codex-local/src/server/device-login-runner.ts`。

## 9. 适配器配置字段

`agentConfigurationDoc` 与 `job.start.config` 白名单只包含：

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `maxRunSec` | number | 3600 | 单次运行上限，最大 14400 |

**没有 `model` 字段**：服务器不指定也不下发模型。不接受任意 `command`、`env`、`cwd`、`extraArgs`：这些在成员本机由代理自己决定，防止服务器配置变成远程执行入口。

服务器侧设置项（实例级，不属于智能体配置）：

| 设置 | 默认 | 说明 |
|---|---|---|
| `memberAgent.pinnedCodexVersion` | `0.160.0` | 经 `hello.ack` 下发，仅对 Codex 引擎生效；必须落在 `>=0.149.0 <0.161.0` 内，否则服务器启动时报错 |
| `memberAgent.codeSyncDir` | 空 | 负责人规定的服务器代码保存目录，仅用于任务说明提示，不由智能体写入 |

## 10. 安全

- 服务器给代理的运行令牌只在 `job.start` 里出现一次，运行结束后服务器侧不保留；
- 运行令牌的权限范围与 `codex_local` 一致，**不得放大**；
- 代理只接受服务器的 `job.start`，不开放任何本地监听端口；
- WebSocket 必须在 `authenticated` 部署模式下才启用；`local_trusted` 模式下拒绝启用并记录原因；
- 服务器要对每个智能体的 `hello` 失败次数限流（每分钟 5 次），防止撞库；
- frp 场景下必须走 `wss://`；`ws://` 仅允许回环地址和私网地址。

## 11. 分阶段任务

每个阶段给出：交付物、验收测试、**必须回传的证据**。证据不齐不算完成。

### 阶段 0：只读核对，回答 Q1–Q6

- 交付物：一份 `doc/plans/2026-10-26-member-agent-phase0-findings.md`，每个问题写：结论、依据（文件:行号）、对本规格的影响；
- 禁止：改任何代码；
- 证据：该文档。**收到负责人确认前不进入阶段 1。**

### 阶段 1：服务器骨架 + 假代理

- 交付物：第 5 节中服务器侧文件；一个测试用假代理脚本（放在测试目录，不进正式包）；
- 验收测试（全部自动化）：
  1. 无 Key / 错 Key / 已撤销 Key / 非 `member_agent` 智能体 → 全部被拒；
  2. 同一智能体第二个连接被拒；
  3. 离线时派任务 → 运行立即失败，`errorCode` 为 `member_agent_offline`，日志里有说明；
  4. 在线时：假代理收到 `job.start`，回 `job.accepted`、两条 `job.log`、一条 `job.result` → 看板运行成功，日志可见，用量与结果正确；
  5. 假代理不回 `job.accepted` → 5 秒后失败；
  6. 假代理停发心跳 → 45 秒内运行失败为 `member_agent_disconnected`；
  7. 操作员取消 → 假代理收到 `job.cancel`；
  8. 跨公司：A 公司智能体的 Key 无法收到 B 公司的任务；
  9. 日志与错误信息中检索不到完整令牌；
- 证据：测试命令与完整输出；`pnpm -r typecheck` 输出；改动文件列表。

### 阶段 2：真实代理 + 无害命令

- 交付物：`packages/member-agent/`，先让它执行一个固定的无害命令（例如回显一行并读取一个测试文件），不接 Codex；
- 验收：在一台 Windows 电脑上实际连上服务器，派任务，看板上看到日志与结果；代理崩溃后服务器侧运行在 45 秒内失败；
- 证据：运行编号、看板截图或接口返回、代理日志（已脱敏）。

### 阶段 3：接入 Codex

- 交付物：按 8.2 选定的路线接入；
- 验收：真实小任务（读一个文件、改一个文件、提交报告、把状态改为 `in_review`）；改动内容、评论作者（必须是该智能体）、`X-Paperclip-Run-Id` 归属（活动日志里该运行）全部正确；用量与本地 `codex_local` 同类任务量级一致；
- 证据：任务编号、运行编号、活动日志导出、产物文件哈希。**不得只用代理自己的"成功"输出作为证据**，要从 Paperclip 接口独立读回。

### 阶段 4：取消与超时

- 验收：运行中取消，Codex 及其子进程在 `graceSec + 10` 秒内全部消失（Windows 进程列表核对）；超过 `maxRunSec` 同样处理；
- 证据：取消前后的进程列表。

### 阶段 5：局域网与 frp

- 验收：同一智能体分别从内网地址和 frp 域名连入，行为一致；通过 frp 连续运行 30 分钟以上的任务不被断开；
- 证据：两种接入的运行编号与日志；frp 配置（去掉密钥）。

### 阶段 6：版本固定与安装包

- 验收：服务器下发新版本号，代理自动切换，成员桌面版更新不受影响；安装脚本一次完成配置、开机自启、登录引导；
- 证据：切换前后版本输出；干净电脑上的安装记录。

### 阶段 7：两成员并行

- 验收：两个成员同时有任务，互不影响，看板分别显示，日志不串；
- 证据：两个运行编号及其日志的对照。

## 12. 阶段 0 问题（已回答，结论见 `2026-10-26-member-agent-phase0-findings.md`）

阶段 0 已完成。下表保留原问题以便追溯；Q1 未发现"无进程号就被误杀"，Q3 用真实 Codex 0.160.0 在本地跑通；各问题的未确认项（长时静默、服务器重启、取消进程树、发布包加载、干净机安装、下载校验）分别由阶段 1、2、4、6 验证。

阶段 1 前置的"工具交付差异清单"已完成并写入 findings 文档末尾，负责人已接受其结论（见决定 6）。

## 12.1 原问题表

| 编号 | 问题 | 为什么重要 | 去哪里找 |
|---|---|---|---|
| Q1 | 没有本地进程号的运行，服务器怎么判超时、怎么回收？`onDispatch()` 之后长时间无输出会不会被误判？ | 决定会不会把正常长任务杀掉 | `server/src/services/heartbeat/run-lifecycle.ts`、`recovery.ts`、`heartbeat.ts` 中无 `processPid` 的分支；`http`/`openclaw_gateway` 适配器的实际表现 |
| Q2 | `AdapterExecutionContext` 的函数型字段，`codex_local` 的 `execute()` 实际用到哪些？哪些在代理本地能就地满足，哪些必须远程调用？ | 决定路线 A 的工作量 | `packages/adapters/codex-local/src/server/execute.ts`（约 591 行解构处起） |
| Q3 | 能否在 Node 环境（非服务器进程）里直接调用 `@paperclipai/adapter-codex-local` 的 `execute()`，用本地目标跑通一个任务？ | 决定走路线 A 还是 B | 写一个最小脚本实测，结果写入文档 |
| Q4 | 运行令牌（`authToken`）的有效期、权限范围；`supportsLocalAgentJwt` 的准确含义 | 长任务会不会中途令牌过期 | `server/src` 里签发运行令牌的位置；该标志在 heartbeat 的使用处 |
| Q5 | 服务器给适配器的 `context` 里，项目与工作目录信息有哪些字段？成员本机目录怎么映射？ | 代理要知道在哪个目录干活 | `heartbeat` 构造 `context` 的位置、`execution-workspaces` |
| Q6 | Codex 固定版本从哪里下载、怎么校验完整性？ | 阶段 6 | 参考 `native-session-executor.ts` 中对 Codex 版本与完整性的处理（约 11600–11700 行），以及 `REMOTE_PROVIDER_PACK_PINS` |

## 13. 与已有 Paperclip Runner 的关系（重要）

代码里已经有一套"Paperclip Runner"体系：`packages/paperclip-runner/`、适配器类型 `paperclip_runner`、WebSocket `/api/runner/v1/connect/:runId`、一次性启动票据、事件持久化与断线重放，并且已有 Codex 版本窗口（`>=0.149.0 <0.161.0`，钉 `0.160.0`）。它的连接方向也是**运行器主动连回服务器**，对 frp 友好。

本期**不采用**它，原因：

1. 文档标注为实验性，受默认关闭的实例开关控制（`doc/architecture/paperclip-runner-compatibility.md`）；
2. 运行器进程由服务器在"实现好的执行环境"里**启动**（`native-session-executor.ts` 约 1.2 万行），成员电脑没有这样的执行环境，要用就得另写"在成员电脑上按需拉起运行器"的部分；
3. 远程运行器的平台检查以 Linux/macOS 为主，Windows 成员电脑能否使用**未验证**；
4. 体量大、与现有直接适配器隔离严格，接入成本和风险都高于本方案。

可借鉴的设计：一次性票据绑定运行、敏感令牌不落盘、命令幂等、有界的恢复。后续若要做断线恢复，应先评估能否复用 PRP，而不是另造一套。

**评估触发条件**：阶段 0 的 Q1 或 Q2 发现本方案不可行，或负责人决定要断线恢复时，回头评估 Paperclip Runner。

## 14. 交付与回报格式

每个阶段结束，执行者按下面格式回报，缺项视为未完成：

```text
阶段：N
改动文件：（列表）
运行过的命令与完整输出：（不要省略失败的）
验收项逐条结论：通过 / 未通过 / 未执行（附原因）
偏离本规格的地方：（没有就写"无"）
遇到但未解决的问题：
下一阶段需要负责人确认的事项：
```

自报的完成度不算数：评审人必须独立从 Paperclip 接口读回结果核对。

## 15. 已知未知（诚实清单）

- Q1 未答，这是决定方案成败的最大风险；
- 函数型上下文字段能否在代理端完整还原，未验证；
- Windows 下 Codex 子进程树的终止，需要在真实机器上测；
- frp 下 WebSocket 的空闲超时与长连接稳定性，需要在专用服务器上测；
- 基线代码此前有 35 个定向测试失败（2026-10-24 推送前检查），阶段 1 开始前要先区分哪些已存在、哪些与本方案相关，不能把原有失败算进新改动。

## 16. 部署说明：frp 与传输加密（运维必须做，代码无法替代）

背景：服务器只能看到"连过来的是谁"。通过 frp 时，连到 Paperclip 的是 frpc，地址在本机或内网，会被判为可信。**外部成员是否用了明文，Paperclip 看不出来。** 因此以下几条必须靠部署配置保证：

1. frps 对外只开 `wss://`：用域名和证书终止加密（frps 的 https 虚拟主机，或前置的 Nginx/Caddy）。**不得对外开放明文 ws 端口。**
2. 前置代理必须设置 `X-Forwarded-Proto`。服务器遇到值为 `http` 会拒绝连接（只会收紧，不会放宽）。
3. frp 使用 TCP 直通方式时，必须由 Paperclip 自己终止 TLS；否则等同明文通过 frp，**不允许**。
4. 内网（局域网、Tailscale 的 100.64.0.0/10）允许明文，因为这些网络本身受控或加密。
5. WebSocket 需要长连接：前置代理的空闲超时不得低于 120 秒，并且必须支持 Upgrade。
6. 上线前用外部网络做一次验证：用明文 `ws://` 连公网入口应失败，用 `wss://` 应成功。

这是专用服务器部署清单的一部分，和 `PAPERCLIP_PUBLIC_URL`、`authenticated` 模式一起检查。
