# 成员代理（member-agent）阶段 2 细化规格

日期：2026-10-25  
前置：阶段 0、阶段 1 已完成并验收；2026-10-25 在专用服务器（Docker，`authenticated` 模式）上用探针脚本跑通"连接 → 派任务 → 令牌写回 → 回报成功"。  
上位规格：[实现规格](2026-10-25-member-agent-implementation-spec.md)（以下称"总规格"）。**总规格的第 2 节硬性规则、第 6 节协议、第 14 节回报格式、"阶段 0 之后的负责人决定"全部继续有效。本文只补充阶段 2 要做的细节，冲突时以总规格为准并回报。**

## 0. 开工前必读与基线

1. 读完总规格、`2026-10-26-member-agent-phase0-findings.md`、阶段 1 报告，以及探针脚本 `C:\Users\11580\AppData\Local\Temp\claude\D--paperclip\6ab6046d-dde6-4102-b82b-75f1fdc0f02b\scratchpad\member-agent-probe.mjs`（它是已被真实服务器验证过的协议用法，**可参考，不可直接当成品**：它没有重连、没有取消、没有配置、没有日志脱敏）。
2. **隔离副本规则沿用**：只在 `E:\workspace\paperclip-member-agent-dev` 里开发，不得编辑 `D:\paperclip`。该副本已包含一处尚未应用到 `D:\paperclip` 的修复（`server/src/adapters/member-agent/test.ts` 改为返回 `pass`），这是已知差异，**不要**把它算进你的补丁。
3. 交付形式：对副本相对基线的新增与改动，生成补丁（新文件用 `git add -N` 后再 `git diff --binary`），放到 `D:\paperclip\doc\plans\2026-10-25-member-agent-phase2-evidence\phase2.patch`。**不得**自行应用到 `D:\paperclip`。
4. 专用服务器的测试只能由负责人执行（我们不登录服务器）：真实服务器验收（第 11.2 节）你要把命令写成可粘贴的步骤交给负责人，由他运行并贴回输出。

## 1. 范围

### 本阶段要做

一个能在 Windows 上常驻运行的成员代理程序**骨架**：读配置、连服务器、按协议收发消息、断线重连、执行"执行器"、处理取消与超时、写日志并脱敏、清理本机子进程。执行器本阶段只有一个无害的 `echo` 执行器，**不启动 Codex**。

### 本阶段不做（做了算偏离）

- 不启动 Codex 或任何 AI 命令行（阶段 3）；
- 不做安装包、开机自启、Windows 服务、自动升级、版本下载（阶段 6）；
- 不做路径替换、会话续接、历史摘要处理（阶段 3，但接口要为它们留好位置，见第 7 节）；
- 不碰服务器端代码、数据库、共享类型；不修改 `D:\paperclip`；
- 不做 frp 相关的任何特殊处理（阶段 5），但客户端的"明文只许内网"自检要做（第 4.4 节）。

## 2. 位置、形态与依赖

- 位置：仓库顶层新目录 `member-agent/`，**不放进 `packages/`**。原因：`pnpm-workspace.yaml` 的 `packages/*` 会把它纳入工作区，Docker 构建用 `pnpm install --frozen-lockfile`（`Dockerfile:54`），新增工作区包会牵动锁文件和服务器镜像；而这个程序是跑在成员 Windows 电脑上的客户端，不属于服务器镜像。
- 自带 `package.json`（`"private": true`，`"type": "module"`），自带 `node_modules`，**不得**通过 `D:\paperclip` 的 `node_modules` 联接去安装依赖（那会改到线上服务的依赖目录）。副本里给它单独安装依赖：只允许依赖 `ws`（版本取 `server/package.json` 里 `ws` 的现用版本，**精确锁定**，不用范围）。
- 运行环境：Node `>=24.11.0`（与 `codex-local` 包一致）。
- 语言：TypeScript，仅用"可擦除语法"（不用 `enum`、`namespace`、参数属性），由 Node 原生类型剥离直接运行，**不加构建步骤**。如果原生类型剥离在 Windows 上有问题，停下回报，不要自行改用别的构建方案。
- 测试：用副本根目录现有的 vitest 运行，测试文件放在 `member-agent/test/`，**不得**依赖服务器代码或数据库。
- 禁止新增其他第三方依赖（不要 commander、yargs、pino、chalk 等），命令行参数、日志、颜色输出自己写，保持体积小、审查面小。

建议目录：

```text
member-agent/
  package.json
  README.md                 # 面向成员的使用说明，中文
  src/
    main.ts                 # 入口，解析命令
    config.ts               # 读取、校验、权限
    transport-check.ts      # 明文只许内网的自检
    connection.ts           # WebSocket 连接、hello、心跳、重连
    protocol.ts             # 帧的构造与解析、字段校验、分块
    job-runner.ts           # 单任务调度、取消、超时
    executors/
      types.ts              # 执行器接口
      echo.ts               # 本阶段唯一的执行器
    process-tree.ts         # Windows 进程树终止
    logger.ts               # 日志与脱敏
    lock.ts                 # 单实例锁
  test/
    ...
```

## 3. 命令行

```text
node member-agent/src/main.ts run     [--config <文件>]   前台运行，Ctrl+C 退出
node member-agent/src/main.ts check   [--config <文件>]   自检：配置合法 → 连接 → hello 通过 → 退出，退出码表示结果
node member-agent/src/main.ts version                    打印代理版本
```

- 不提供 `login`、`install`（后续阶段）；
- 未知命令或参数：打印中文用法并以退出码 2 结束；
- 所有面向成员的输出用简体中文，一句话说清楚发生了什么、该怎么办。

### 退出码

| 码 | 含义 |
|---|---|
| 0 | 正常退出（Ctrl+C，或 `check` 成功） |
| 1 | 未预期的内部错误 |
| 2 | 命令行或配置错误 |
| 3 | 服务器拒绝了认证（401），Key 无效或被撤销，**不重试** |
| 4 | 服务器拒绝了传输方式（403）、或智能体不被允许（`member_agent_not_allowed`），**不重试** |
| 5 | 已有另一个本机代理实例在运行（单实例锁） |

## 4. 配置

### 4.1 位置与格式

`%APPDATA%\paperclip-member-agent\config.json`（可用 `--config` 覆盖）。UTF-8，无 BOM。

```json
{
  "serverUrl": "http://192.168.0.213:3100",
  "agentKey": "…",
  "executor": "echo",
  "projectDirs": {},
  "defaultCwd": ""
}
```

- `serverUrl`：必填，`http://` 或 `https://`，不得带路径、查询、账号密码；
- `agentKey`：必填；也可由环境变量 `PAPERCLIP_AGENT_KEY` 提供，**环境变量优先**；
- `executor`：本阶段只接受 `"echo"`，其他值报配置错误（阶段 3 增加 `"codex"`）；
- `projectDirs`、`defaultCwd`：本阶段只校验"是对象/字符串"，不使用；阶段 3 使用；
- 未知字段：**拒绝并指出字段名**，不静默忽略（防止拼写错误导致用错配置）。

### 4.2 校验

每条错误要写明字段名、问题、怎么改。例如：`配置错误：serverUrl 必须以 http:// 或 https:// 开头，当前值是 "192.168.0.213:3100"`。多条错误一次全部列出，不要改一条报一条。

### 4.3 密钥保护

- 读取配置时，如果配置文件权限允许当前用户以外的账户读取，**打印警告**并给出收紧命令（`icacls`），但不阻止运行；
- Key 在任何输出、日志、错误信息里**只显示前 4 位加省略号**；
- 不把 Key 放进命令行参数（会进入进程列表和 shell 历史）。

### 4.4 明文自检

代理在连接前检查服务器地址：

- `https://` → 通过；
- `http://` 且主机是回环、私网、Tailscale（`100.64.0.0/10`）地址，或是不含点号的内网主机名 → 通过；
- `http://` 且主机是公网 IP，或是有公网域名后缀的主机名 → **拒绝启动**，退出码 2，提示"明文只允许用于内网，请改用 https://"。
- 判断规则与服务器端 `isMemberAgentTransportAllowed`（`server/src/realtime/member-agent-ws.ts`）保持一致，**不要把规则写得更宽松**。主机名无法判断时按"不通过"处理。

## 5. 连接生命周期

```text
启动 → 读配置 → 单实例锁 → 明文自检 → 连接 → 发 hello → 收到 hello.ack(ready)
  ready ⇄ 执行任务
  任何断开 → 若是可重试 → 退避等待 → 重新连接
```

### 5.1 hello

- 连接成功后立即发送 `hello`，字段：`agentVersion`、`codexVersion`（本阶段固定 `"none"`）、`hostname`、`platform`（`win32` 等），每个字符串 ≤255 字符；
- 10 秒内没收到 `hello.ack` 或 `hello.reject`：视为失败，断开并重试；
- 收到 `hello.ack` 后读取 `heartbeatSec`、`maxRunSec`、`pinnedCodexVersion`；`pinnedCodexVersion` 本阶段只打印，不做任何版本动作。

### 5.2 心跳

按服务器给的 `heartbeatSec`（缺省 15）发送 `heartbeat`。服务器 45 秒没收到任何消息会断开，所以代理**不得**因为在忙任务就停发心跳：心跳必须在独立的定时器上，不受日志发送、执行器阻塞影响。

### 5.3 拒绝与断开的处理

| 情况 | 处理 |
|---|---|
| HTTP 401（升级阶段） | 打印"Key 无效或已撤销"，退出码 3，不重试 |
| HTTP 403（升级阶段） | 打印"服务器拒绝了这条连接的传输方式"，退出码 4，不重试 |
| HTTP 429 | 退避至少 60 秒后重试，打印原因 |
| `hello.reject`，`member_agent_not_allowed` | 退出码 4，不重试，提示"这个 Key 对应的智能体不是成员智能体或已被暂停" |
| `hello.reject`，`already_connected` | 打印"这个智能体已经有另一台电脑在线"，等 30 秒后重试，**不计入重试上限**，一直重试到被人工停止 |
| `hello.reject`，其他 | 退避重试 |
| 连接被对端关闭、网络错误、心跳无响应 | 退避重试 |
| 服务器关闭码表示协议错误 | 打印关闭码和原因，退避重试，**同时**写入日志，便于排查 |

### 5.4 退避

指数退避：1、2、4、8、16、30 秒，上限 30 秒，每次加 0–20% 的随机抖动。连接成功并收到 `hello.ack` 后重置。每次重试打印一行中文说明（"连接断开，N 秒后重试"）。

### 5.5 任务进行中连接断开

服务器会在心跳超时后把这次运行标记为失败。所以代理**必须**：

1. 立即对正在运行的执行器发出取消；
2. 等待它在 `graceSec`（缺省 20 秒）内结束，必要时强制终止进程树；
3. 丢弃该任务的所有后续结果，**不得**在重连后补发 `job.result`（服务器已经结束了那次运行，旧任务的结果会被忽略；重发还可能让令牌写回操作发生在已失败的运行上）；
4. 日志里写明"连接断开，已中止任务 <jobId>"；
5. 然后正常重连。

## 6. 协议实现细则

以总规格第 6 节为准，本节补充实现上容易错的点（这些都来自阶段 1 的服务器实现，已被测试固化）：

- 每帧是一条 UTF-8 文本 JSON，**必须**含 `v: 1` 和字符串 `type`；单帧 ≤ 256 KB，超过会被服务器断开；
- `job.accepted` 必须在收到 `job.start` 后**立即**发送，先于任何准备工作（服务器 5 秒内没收到会判失败）；
- `job.log`：`seq` 从 1 开始递增（每个任务内独立），`stream` 为 `stdout` 或 `stderr`，`chunk` ≤ 32 KB（UTF-8 字节）。**切分必须在字符边界上**，不得把一个汉字切成两半；
- `job.event`：`seq` 同样从 1 递增，**与 `job.log` 的 `seq` 各自独立计数**；
- `job.usage`、`job.meta`：本阶段 `echo` 执行器不发；协议层要支持，字段必须是服务器严格校验的那些，**多发一个未知字段就会被判为协议错误**；
- `job.result` 只能发**一次**，必须包含 `exitCode`（整数或 null）、`signal`（字符串或 null）、`timedOut`（布尔）。可选字段只能是：`errorCode`、`errorMessage`、`errorFamily`、`retryNotBefore`、`errorMeta`、`summary`、`resultJson`、`sessionId`、`sessionDisplayId`、`sessionParams`、`clearSession`、`usageComplete`、`usage`、`usageByModel`、`usageBasis`、`provider`、`biller`、`model`、`billingType`、`costUsd`、`costUsdExact`、`costStatus`、`pricingContext`、`pricingProvenance`、`cacheAdjustedCostUsd`、`providerRequestId`、`executionRecovery`。**构造结果时对照服务器 `execute.ts` 的 `resultSchema` 逐项核对，任何不在其中的字段都不得发送**；
- 对收到的未知 `type`：忽略并写一条日志；收到 `v` 不是 1：断开；
- 收到 `job.start` 时，如果已经有任务在运行：**不**接受，直接发 `job.result`（`exitCode: 1`，`errorCode: "member_agent_busy"`，`errorMessage` 写明原因）；
- 收到 `job.cancel` 时 `jobId` 不匹配当前任务：忽略并写日志。

## 7. 执行器接口

```ts
export interface ExecutorHooks {
  log(stream: "stdout" | "stderr", text: string): void;       // 由 job-runner 负责分块、编号、发送
  event(event: Record<string, unknown>): void;                 // 本阶段 echo 不用，接口先留
  signal: AbortSignal;                                         // 取消或超时时触发
  readonly job: JobStart;                                      // 完整任务包（含 authToken，不得写日志）
  readonly serverUrl: string;                                  // 代理自己连接用的地址
}

export interface ExecutorResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  summary?: string;
  errorCode?: string;
  errorMessage?: string;
  // 其余可选字段与 job.result 白名单一致，由 job-runner 在发送前再校验一遍
}

export interface Executor {
  readonly name: string;
  execute(hooks: ExecutorHooks): Promise<ExecutorResult>;
}
```

要求：

- 执行器**不直接碰 WebSocket**，只通过 `hooks` 输出。阶段 3 的 Codex 执行器要能直接实现这个接口，所以接口里已经带上 `job`、`serverUrl`、`signal`，**不要**为了简化删掉；
- `job-runner` 负责：序号、分块、`job.accepted`、结果发送、取消超时、保证 `job.result` 只发一次、任何路径下都清理资源；
- 执行器抛出的异常：转成 `exitCode: 1`、`errorCode: "member_agent_executor_error"`，`errorMessage` 写简短原因（**经过脱敏**），不得把堆栈整段发给服务器。

### 7.1 `echo` 执行器行为

目的：用最小代价验证"任务全流程"，且**不会引起服务器反复续跑**。

1. 打一行 `stdout`：`成员代理收到任务 <jobId>`；
2. 如果任务上下文有工单 ID（`job.context.issueId` 或 `taskId`）：
   - 用 `job.authToken` 和 `X-Paperclip-Run-Id: <jobId>` 请求头，调用 `POST {serverUrl}/api/issues/{issueId}/comments`，正文是固定中文说明（含代理版本和主机名，**不含**任何令牌）；
   - 再调用 `PATCH {serverUrl}/api/issues/{issueId}`，把状态改为 `done`，并带一条评论；
   - 两个请求都用 UTF-8 JSON，经 `fetch` 发送，**不要**用命令行拼接；
   - 任一请求失败：打 `stderr`，结果 `exitCode: 1`，`errorCode: "member_agent_echo_writeback_failed"`，`errorMessage` 写 HTTP 状态；
3. 没有工单 ID：只打日志，结果成功；
4. 响应取消：在每个步骤前检查 `signal`，被取消则立即结束并返回 `exitCode: 1`；
5. `summary` 写一句话，例如"echo 执行器完成"。

`echo` 执行器 `PATCH` 为 `done` 是**测试专用**行为，要在代码注释里写明，防止后来被误当成通用逻辑。

## 8. 日志与脱敏

- 日志目录：`%APPDATA%\paperclip-member-agent\logs\`，文件名 `agent-YYYYMMDD.log`，按天滚动，保留最近 7 天，启动时清理更早的；
- 每行一条，格式 `时间 级别 消息`，UTF-8；
- 同时把"成员需要知道的事"打印到控制台（连接成功、收到任务、任务结束、重试原因、错误）；调试细节只写文件；
- **脱敏对象**：`agentKey`、`job.authToken`、`job.runtimeTools.bearerToken`。脱敏必须覆盖：普通文本、JSON 序列化后的字符串、跨日志分块拆开的情况（至少对每个流保留一段"待确认尾部"，不得在块边界泄露令牌前缀）；
- 任何日志、控制台输出、发给服务器的 `job.log`/`errorMessage`，**输出前都要经过同一个脱敏函数**；
- 脱敏器要有单元测试，覆盖：整串出现、两块中间拆开、出现在 JSON 键或值里、出现在 URL 里。

## 9. 取消、超时与进程树

- `job.cancel`：触发 `signal`，等待执行器在 `graceSec` 内返回；超时则强制终止；之后发 `job.result`（`errorCode: "cancelled"`）。服务器等的时间是 `graceSec + 10` 秒，所以代理的总处理时间**必须小于它**，否则服务器会判"未确认本机进程已停止"；
- 本地超时：以 `job.start.config.maxRunSec`（缺省 3600）为准，到点触发 `signal`，结果 `timedOut: true`；不依赖服务器的计时；
- **进程树终止**（`process-tree.ts`）：对执行器启动的任何子进程，取消时必须整棵终止。Windows 上用 `taskkill /PID <pid> /T /F`（经 `execFile`，不经 shell），并在其后确认 PID 已不存在；如果 `taskkill` 失败，记录并**返回失败结果而不是假装成功**。本阶段 `echo` 不启动子进程，所以要用一个**测试专用的假子进程**（例如启动一个会再启动孙进程并长期休眠的 Node 脚本）来验证这段代码，验证方法：终止后孙进程也不在进程列表里；
- Ctrl+C（`SIGINT`）：先停止接收新任务，取消正在运行的任务并等待其结束（最多 `graceSec`），再关闭连接，退出码 0；第二次 Ctrl+C 立即强制退出。

## 10. 单实例与资源

- 单实例锁：在 `%APPDATA%\paperclip-member-agent\agent.lock` 写入进程号；启动时若锁文件存在且该进程仍在运行，打印"已有代理在运行（进程号 N）"，退出码 5；若进程已不存在，视为陈旧锁，覆盖并继续；
- 不监听任何本地端口；
- 同一时刻只运行一个任务；
- 内存：日志发送队列要有上限（例如 1000 帧或 8 MB），超过则丢弃最旧的 `job.log` 并在日志里记一条"已丢弃 N 条输出"，**不得无限增长**；`job.result` 永不丢弃。

## 11. 验收

### 11.1 自动化测试（在副本里运行，全部通过）

测试用进程内的假服务器（用 `ws` 起一个本地服务，端口随机，只监听回环），覆盖：

1. 配置：缺字段、类型错、未知字段、`serverUrl` 格式错、环境变量覆盖配置中的 Key、多个错误一次列全；
2. 明文自检：公网 IP + http 拒绝；`https` 通过；回环、10.x、172.16–31.x、192.168.x、100.64.x、无点号主机名通过；`172.32.x` 拒绝；
3. 连接：正常 hello 与 ack；hello 超时 10 秒；401 → 退出码 3 不重试；403 → 退出码 4 不重试；429 → 至少 60 秒后重试（用可注入时钟，不真等）；
4. `already_connected`：30 秒后重试，不计入上限；
5. 退避序列正确（1、2、4、8、16、30、30…）、成功后重置、抖动在 0–20%；
6. 心跳：按 ack 的 `heartbeatSec` 发送；在执行器长时间同步阻塞（用忙等模拟）时心跳不停；
7. 任务：收到 `job.start` 立即回 `job.accepted`；`echo` 的日志序号连续；`job.result` 只发一次；
8. 已有任务时再来 `job.start` → 回 `member_agent_busy`，原任务不受影响；
9. 取消：收到 `job.cancel` 后在 `graceSec` 内结束，结果 `cancelled`；
10. 本地超时：到 `maxRunSec` 触发 `signal`，结果 `timedOut: true`；
11. 任务中连接断开：执行器被取消，**重连后不补发结果**；
12. 日志分块：超过 32 KB 的输出被切成多块，**含多字节字符的块边界不破坏字符**；
13. 结果白名单：构造含未知字段的结果，应被 `job-runner` 拦下并转成协议安全的失败结果，而不是发给服务器；
14. 脱敏：见第 8 节四种情形；密钥永不出现在控制台输出、日志文件、发给假服务器的任何帧里（测试里把这三处全部检索一遍）；
15. 进程树终止：假子进程加孙进程，取消后两者都不存在（仅在 Windows 上运行；其他平台标记为跳过并说明）；
16. 单实例锁：活进程的锁拒绝；陈旧锁覆盖；
17. Ctrl+C：第一次优雅退出，第二次强制；
18. 队列上限：灌入超限日志，丢弃旧日志、保留结果。

另外：`pnpm exec tsc --noEmit`（若 `member-agent` 有自己的 tsconfig，对它单独运行）新增错误为 0；副本里**其他包的既有测试不受影响**（至少重跑阶段 1 的协议测试 39 项和注册表测试）。

### 11.2 真实服务器验收（由负责人执行，你写命令）

在专用服务器（`http://192.168.0.213:3100`）上，用负责人在界面里创建的 Key 与 `成员智能体-测试` 智能体：

- **A1**：`check` 命令，退出码 0；
- **A2**：`run` 启动，看板上该智能体连接成功，控制台出现"已连接"；
- **A3**：派一个任务：只出现**一次**运行，状态 `succeeded`；任务有一条由该智能体写的评论；任务状态最终为 `done`；**没有**自动续跑出现第二次运行；
- **A4**：运行日志在看板里可读，没有任何令牌；
- **A5**：在任务运行中按 Ctrl+C，代理优雅退出，该运行在服务器上以失败收尾且有明确原因，不挂在"运行中"；
- **A6**：运行中直接关闭代理的控制台窗口（模拟异常退出），45 秒内服务器把运行判为失败；
- **A7**：用一个故意写错的 Key，`check` 退出码 3，输出中文提示；
- **A8**：两个代理同时用同一个 Key：第二个打印"已有另一台电脑在线"，原连接不受影响。

要求你给出的命令必须是**成员可以直接复制粘贴的 PowerShell 命令**，Key 只通过环境变量传入，不写进命令行参数，也不要求负责人把 Key 贴回对话。

## 12. 为阶段 3 预留（本阶段不实现，只保证不挡路）

- 执行器接口已含 `job`、`serverUrl`、`signal`；
- 配置里的 `projectDirs`、`defaultCwd` 已定义并校验类型；
- `hello` 的 `codexVersion` 字段现在固定 `"none"`，阶段 3 改为读取本机固定版本 Codex 的 `--version`；
- 阶段 3 的 Codex 执行器会以库的方式调用 `@paperclipai/adapter-codex-local/server` 的 `execute()`（总规格 8.2、阶段 0 Q2/Q3）。**这意味着代理最终要能解析仓库内的工作区包**，与本阶段"独立目录、独立依赖"的做法有张力。这是已知问题，**本阶段不解决**，列在第 14 节，由负责人在阶段 3 前决定；你不要为此提前做任何打包方案。

## 13. 禁止事项

- 不得编辑 `D:\paperclip`，不得向其应用补丁；
- 不得重启、停止任何服务，不得访问线上 `3100` 之外的本机服务做测试（`localhost:3100` 是负责人本机的开发实例，你的测试**不要连它**，只连进程内假服务器）；
- 不得登录专用服务器，不得向其写入任何东西；真实服务器验收由负责人执行；
- 不得把任何令牌、Key、密码写进文件、日志、测试快照、补丁、报告；测试里用明显的假值；
- 不得 `git commit`、`git push`，不得加任何 AI 署名；
- 不得新增 `ws` 以外的依赖；不得修改服务器协议（如需修改，停下回报）；
- 遇到本文没写清楚的地方，停下来回报，**不要自行决定**。

## 14. 回报格式与未决问题

回报按总规格第 14 节格式，另外必须包含：

- 副本里新增文件清单与每个文件的职责一句话；
- 第 11.1 节 18 项逐条的结论、对应测试名、完整测试输出（含失败过的）；
- 类型检查前后对比；
- 阶段 1 测试 39 项和注册表测试的重跑结果；
- 第 11.2 节 A1–A8 的**可粘贴命令清单**；
- 补丁路径，以及用 `git apply --check` 在干净临时副本上验证的结果。

### 未决问题（需要负责人决定，不阻塞阶段 2）

1. 阶段 3 的代理如何拿到 Codex 适配器库：（a）成员机器上放一份仓库检出和依赖；（b）用打包工具把需要的部分打成单文件；（c）不用库，改为代理自己实现提示词和参数（路线 B）。**建议阶段 3 开始前先做一个小实验再选。**
2. 成员本机的 Codex 固定版本由谁安装、安装到哪里（阶段 6）。
3. 开机自启方式：任务计划程序还是 Windows 服务（阶段 6）。
