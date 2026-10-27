# 多人并行开发、工作树与 frpc 部署审查

日期：2026-10-24  
用途：供 Claude 在额度恢复后进行第二次代码审查，也作为后续多人协作和服务器部署的操作依据。

## 一句话结论

多人并行开发的正确控制方式是：**负责人用 Paperclip 建立任务依赖，Paperclip 为并行代码任务分配独立工作树，任务完成时用真实 Git diff 验证变更；frpc 只负责把 Paperclip 的访问入口转发到外网，不能替代 Paperclip 的认证和权限。**

## 本轮按代码核对的事实

### 派工不是天然只有负责人可以做

创建任务、重新分配任务都会经过 `tasks:assign` 授权判断，见 `server/src/routes/issues.ts` 的 `assertCanAssignTasks`。系统提供权限边界，但没有把“所有派工必须由一个负责人完成”硬编码为固定规则。

因此，若采用一个负责人统一派工的组织方式，需要在公司/Agent 权限中收紧普通成员和普通 Agent 的任务分配权限，只给负责人或协调 Agent 保留分配权限。

### 结构化依赖会阻止真正的执行

Paperclip 使用 `issueRelations` 保存 `blocks` 关系，运行队列在执行前读取 dependency readiness。未完成 blocker 时，普通实现运行会被跳过并记录等待；blocker 完成后，系统可以发出 `issue_blockers_resolved` 唤醒。

关键实现：

- `server/src/services/issues.ts`：`assertInProgressBlockersResolved` 和 `syncBlockedByIssueIds`；
- `server/src/services/heartbeat/queue.ts`：依赖检查和 execution wait；
- `server/src/modules/run-dispatch/domain/policy.ts`：依赖阻塞事实进入派发策略；
- `server/src/__tests__/heartbeat-dependency-scheduling.test.ts`：覆盖阻塞任务不启动、依赖解除后恢复等路径。

这只对真正写入的结构化依赖生效。评论里写“等待 B-1”不会自动变成 blocker。依赖阻塞时，针对用户评论的解释型交互仍可能运行，但它不应执行被阻塞任务的实现工作。

### 当前已有的是任务/运行锁，不是文件锁

`/issues/:id/checkout` 和 issue service 会保护任务 checkout、`checkoutRunId`、`executionRunId` 和执行所有权。heartbeat queue 也会避免同一任务的并发执行。

执行工作区还具有生命周期锁、恢复/清理锁和活动运行检测。`git_worktree` 可以把并行任务放进不同工作树。

当前没有一项通用机制可以在运行前知道：

```text
A-1 会修改 src/shared/a.ts
B-1 也会修改 src/shared/a.ts
```

因此，工作树能防止两个 Agent 直接覆盖对方的未提交文件，但不能自动消除最后合并时的逻辑冲突。Paperclip 也不会从自然语言评论中推断文件冲突。

### 当前 Codex 会话和 Paperclip 任务是两套记录

`codex_local` 通过 `previous_response_id` 维持 Paperclip Agent 的跨 heartbeat 上下文，并为 Agent 使用隔离的 `CODEX_HOME`。这保证服务端 Agent 能继续工作，但不会把 Paperclip 的任务板自动显示为每个人电脑上的 Codex App/CLI 历史。

Paperclip 的任务、运行、日志、评论和活动仍以 Paperclip 为准。若要在 Codex CLI/App 中查询 Paperclip，需要另外接入 Paperclip MCP/API；这属于连接层，不是当前 `codex_local` 自动提供的功能。

## 推荐的公司协作流程

### 负责人控制层

负责人只需要做三件事：

1. 创建目标和总任务；
2. 拆分任务，指定负责人和结构化 blocker；
3. 在最终评审阶段验收。

普通成员和普通 Agent 可以执行和回报自己的任务，但不应默认拥有全公司的派工权限。

### 并行执行层

代码任务采用以下规则：

- 每个**正在并行执行**的任务使用独立 `git_worktree`；
- 同一任务的后续 heartbeat 复用它自己的工作树；
- 有依赖的后续任务从前置任务的最新分支/工作区继续，不能从过期的 `main` 重新开始；
- 没有依赖、且修改范围不同的任务可以并行；
- 可能修改同一个文件或同一个模块的任务必须建立依赖并串行执行；
- Agent 不直接合并生产分支，统一由负责人或评审流程合并。

工作树不是为了“防止提交混乱”才存在，主要是隔离未提交文件、HEAD、测试产物和运行状态。黑板负责协调，工作树负责物理隔离。

### 任务卡片必须包含的机器可读信息

文件路径不应只写在提示词里。当前可以先写进任务文档，后续建议进入结构化字段：

```json
{
  "dependsOn": ["B-1"],
  "changeScope": {
    "include": ["server/src/messages/**"],
    "exclude": ["packages/db/**"],
    "shared": []
  },
  "verification": ["pnpm test -- messages"]
}
```

更重要的校验发生在运行结束后：Paperclip 应根据运行前后的 workspace snapshot 生成真实 `changedPaths`、新增/删除/重命名文件和 diff fingerprint。若实际 diff 超出 `changeScope`，任务不能自动进入 `done`，而应进入 scope violation/needs review。

这比在 Agent prompt 中提醒“只能改这些文件”可靠，因为 prompt 是约束建议，Git diff 才是事实证据。

## 建议的后续 Paperclip 产品增强

当前代码已经覆盖任务依赖、checkout 锁和工作树生命周期，但下面这一层尚未完整实现：

1. 在 issue/execution policy 中加入结构化 `changeScope`；
2. 为活动任务登记路径范围声明；
3. 对重叠范围进行并行 admission 检查；
4. 在运行结束时保存真实 `changedPaths`、diff fingerprint 和 scope verdict；
5. 范围越界时阻止自动完成并通知负责人；
6. 在任务、运行和评审页面显示“声明范围 / 实际修改 / 越界项”。

这不是重写 Paperclip 调度器，而是建立“文件范围声明 + 实际 diff 校验”层。依赖关系仍然负责顺序，工作树仍然负责并行隔离。

## frpc 内网穿透是否可行

### 结论

可以。只要 Paperclip 服务运行在内网服务器上，frpc 将一个外部可访问的域名/端口转发到 Paperclip 的 HTTP 服务，非局域网用户就能访问 Paperclip 前端和 API。

Agent 是否继续工作与 frpc 是否在线是两件事：

- Paperclip 服务、数据库、工作区和 Agent 进程都在服务器上时，frpc 断开只会影响外部用户访问和实时页面更新；服务器上的任务不会因为浏览器或隧道断开而自动停止；
- 如果 Agent 或 webhook 发送方本身在外网，需要通过外部地址回调 Paperclip，则 frpc 必须稳定转发 API，并配置正确的公开 URL；
- 如果 Codex/Claude 都在服务器上运行，它们调用供应商 API 通常是服务器的出站连接，不需要通过 frpc 回到自己。

### 推荐部署形态

```text
外部浏览器
    │ HTTPS
    ▼
frps 公网服务器
    │ frpc 隧道
    ▼
内网 Paperclip Server :3100
    ├── PostgreSQL
    ├── 文件/对象存储
    ├── Agent 工作区
    └── Codex/其他 Agent 运行进程
```

推荐使用 `authenticated` 模式，不要把 `local_trusted` 直接暴露到公网。需要配置：

- `PAPERCLIP_DEPLOYMENT_MODE=authenticated`；
- `PAPERCLIP_DEPLOYMENT_EXPOSURE=private`（仅 VPN/frp 私网访问）或 `public`（真正公网访问）；
- `PAPERCLIP_PUBLIC_URL=https://你的外部域名`；
- `PAPERCLIP_ALLOWED_HOSTNAMES` 按实际域名配置；
- `BETTER_AUTH_SECRET`、工具签名密钥和数据库凭据只放服务器密钥环境；
- 数据库、实例目录和附件存储必须持久化。

Paperclip 的部署模式已经区分 `local_trusted`、`authenticated/private` 和 `authenticated/public`，并把公开 URL 用于认证回调、邀请链接和 webhook 地址。参考 `doc/DEPLOYMENT-MODES.md`、`doc/DOCKER.md` 和 `docs/api/routines.md`。

### frpc 必须验证的网络能力

Paperclip 的实时运行界面会使用 WebSocket 事件，例如 `heartbeat.run.event` 和 `heartbeat.run.log`。因此 frpc 或前置反向代理必须支持：

- HTTP/HTTPS 转发；
- WebSocket Upgrade；
- 长连接和较长空闲超时；
- 大请求体和文件上传；
- 正确转发 HTTPS 终止后的 Host/Origin；
- 不缓存 API、SSE 或 WebSocket 响应。

如果 frpc 只转发普通 HTTP 而没有正确支持 WebSocket，任务仍可能在服务器上继续，但浏览器会看不到实时进度，需要刷新页面才能看到部分状态。

### 外网访问的安全底线

- frp 不是身份认证系统；必须启用 Paperclip authenticated 模式；
- 优先使用 HTTPS，证书放在 frps 或前置反向代理；
- 公网部署应启用认证限流和严格 Host/Origin 配置；
- 不把 Agent API Key 放入前端代码、URL 或 frpc 配置；
- frps 管理端口不能和 Paperclip 服务端口一起暴露给普通用户；
- Paperclip、PostgreSQL、工作区和 frp 服务都要有重启策略和监控；
- 先用 Tailscale/VPN 或 frp 私网模式验证，再考虑公开访问。

### 验证顺序

1. 在内网直接访问 Paperclip，确认健康检查、登录、Agent 运行和任务日志正常；
2. 通过 frpc 外部域名访问登录页；
3. 验证登录、刷新、任务列表和文件上传；
4. 启动一个短任务，确认 WebSocket 实时日志能持续刷新；
5. 关闭外部浏览器或临时停止 frpc，确认服务器上的任务仍按预期完成；
6. 恢复 frpc，确认重新打开页面可以看到最终状态和运行日志；
7. 验证外部 webhook/邀请链接使用的是 `PAPERCLIP_PUBLIC_URL`，而不是内网地址。

## Claude 二次审查清单

Claude 恢复额度后，优先审查以下内容：

1. `server/src/services/heartbeat/queue.ts`：执行等待恢复时是否可能在 enqueue 失败前写入 `resumedAt`，造成永久丢唤醒；
2. `server/src/services/heartbeat.ts`：额度恢复运行是否在所有任务唤醒成功前就写入 handled 集合，导致短暂错误无法重试；
3. `packages/adapters/gemini-local/src/server/execute.ts`：Windows argv 的实际引号转义长度是否可能超过限制；
4. 任务分配权限是否能实现“只有负责人/协调 Agent 派工”；
5. `git_worktree` 并行任务在分支合并、workspace finalize 失败和恢复时的行为；
6. WebSocket/长连接经过 frpc 或 HTTPS 反向代理后的认证、Origin 和重连行为；
7. 不要把“结构化依赖测试通过”扩大解释为“Paperclip 自动发现所有文件冲突”。

## 最终建议

第一阶段不改 Paperclip 核心架构：部署 authenticated Paperclip，使用任务依赖和 `git_worktree` 管理并行开发，负责人统一派工和合并。

第二阶段增加 `changeScope + actual diff` 校验，让系统能够证明谁实际修改了哪些文件，并自动阻止越界完成。

frpc 可以用于外网访问和移动端管理，但它只是网络通道。Paperclip 的认证、数据库持久化、工作区隔离和 Agent 调度仍然必须在服务器端正确配置。

## 第二次审查结果（Claude，2026-10-25，只核对代码，未跑测试）

| 清单项 | 结论 | 依据 |
|---|---|---|
| 1. 执行等待恢复丢唤醒 | **风险属实** | `heartbeat/queue.ts` 的 `resumeSkippedExecutionWaits` 先把 `executionWait.resumedAt` 写成已处理，再调用 `enqueueWakeup`；入队失败只记 warn 日志。之后查询条件要求 `resumedAt is null`，该唤醒永远不会再被重试。 |
| 2. 额度恢复唤醒 | **风险属实** | `heartbeat.ts` 的 `reconcileProviderQuotaResetWakes` 在发唤醒前就把 run id 放进 `providerQuotaResetHandledRunIds`；某个任务唤醒抛错只记日志，进程不重启就不再重试。另外每个 Agent 只取最近一次失败，且 `later` 判定只要之后有任何运行就整体跳过。 |
| 3. Gemini Windows 参数长度 | **已缓解** | 工作区未提交改动里，Windows 下提示词超过 24000 字符改为写文件，`--prompt` 只让 Gemini 去读文件（`prompt-file.ts`、`execute.ts`）。24000 是否留足转义余量，仍需用带大量引号的长提示实测。 |
| 4. 只有负责人能派工 | **可配置，不是默认硬规则** | `agents.ts` 的 `buildAgentAccessState`：CEO 角色、拥有 `canCreateAgents` 的 Agent、或被授予 `tasks:assign` 的主体可以派工；另有 `tasks:assign_scope`（限定在某个 Agent 子树内）。收紧办法是：只给协调 Agent 授权，不给普通 Agent 授 `canCreateAgents`。 |
| 5–6 | 未核对 | 工作树合并/回收失败路径、frpc 下 WebSocket 与 Origin，需要实机验证，代码阅读不够。 |

### 建议的修复方向（未改代码）

1. 两处都改为"入队成功后再标记已处理"。幂等键 `execution-wait-resume:<id>` 和 `provider_quota_reset:<run>:<issue>` 已经存在，重试是安全的。
2. 额度恢复那一处，把 run id 加入已处理集合的时机推迟到所有目标任务唤醒都成功之后。
3. 对 Gemini 提示词文件补一条含大量引号长提示的 Windows 实测。
