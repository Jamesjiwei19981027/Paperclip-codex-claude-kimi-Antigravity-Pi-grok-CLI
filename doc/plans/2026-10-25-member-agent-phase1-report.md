# 成员本机智能体：阶段 1 实施与验收报告

日期：2026-10-25

阶段：1（服务器骨架 + 测试用假代理）。

**当前结论：9 项规定的自动化场景通过，相关测试无新增失败，直接类型检查无新增错误；阶段 1 尚未完成验收，不进入阶段 2。** 原因是下列安全缺口和运行环境问题，不能仅凭测试通过宣称已满足整个规格。

## 需要负责人决定

1. **后续必须脱离正在运行的源码目录继续开发。** 3100 实际由 `tsx watch` 管理。虽然本次没有执行任何重启、停止进程命令，也未向业务派发或取消任务，但进程已从备份记录的 31636 变为 59752；当前进程创建于 16:43:37，服务报告启动于 16:43:51。这与源码编辑时间重合，符合自动重载行为。决定 10 的“3100 不得重启”条件因此未能保证。发现后已停止写产品源码，仅继续完成测试结果核对和本报告。应先安排独立开发副本及随机测试端口，避免后续编辑触发线上重载；本次没有修改 watcher、切换服务或回滚代码。
2. **公网传输限制仍需修正。** `server/src/realtime/member-agent-ws.ts:94` 的升级入口尚未校验 TLS/明文连接的对端地址，因而在 authenticated 部署中不能阻止公网直接使用明文 `ws://`。这不符合规格第 10 节。需补充“直连公网必须加密、明文仅限回环/私网”的约束及负向测试；反向代理终止 TLS 时如何信任其传入信息应明确，不能盲信客户端的 `X-Forwarded-Proto`。本轮因上述自动重载问题停止继续改源码，该缺口保留，不作为已完成项。

## 备份与改动边界

产品代码修改前已备份至 `E:/AI_Data/backups/paperclip/2026-10-25-before-member-agent-phase1`。该目录包含源码副本、Git bundle、未提交补丁、清单和校验收据；14,716 个文件，共 613,833,409 字节，源码副本 SHA-256 核对及 bundle 验证通过。该备份不包含数据库。

本次新增 7 个源码/测试文件：

- `server/src/adapters/member-agent/index.ts`：注册环境工具交付类型和能力说明。
- `server/src/adapters/member-agent/settings.ts`：唯一的版本、同步目录常量存放处；只有批准的两个常量。
- `server/src/adapters/member-agent/execute.ts`：任务分发、历史摘要、runtimeTools、回调转发、取消、超时、错误及脱敏。
- `server/src/adapters/member-agent/test.ts`：缺少具体身份时返回规定的 warn。
- `server/src/adapters/member-agent/protocol.test.ts`：假代理及隔离集成测试；假代理仅存在于测试文件。
- `server/src/realtime/member-agent-ws.ts`：连接认证、公司隔离、连接表、协议、心跳、限流。
- `server/src/realtime/agent-key-auth.ts`：共用的请求头 Bearer Key 认证函数。

本次修改 7 个已有文件：

- `server/src/realtime/live-events-ws.ts`：仅抽取 Key 校验调用；保留原来的查询令牌兼容行为。
- `server/src/index.ts`：接入新的 WebSocket 服务。
- `server/src/adapters/registry.ts`：加入新适配器。
- `server/src/adapters/builtin-adapter-types.ts`：加入类型。
- `server/src/adapters/registry.test.ts`：固定名单仅新增 `["member_agent", "environment"]` 一项预期；没有删除或跳过断言。**这是唯一修改的已有测试文件。**
- `packages/shared/src/constants.ts`：加入可选类型。
- `ui/src/adapters/adapter-display-registry.ts`：加入显示名称、描述和已有图标。

文档与证据为本报告及 `doc/plans/2026-10-25-member-agent-phase1-evidence/`。规格决定 10 是负责人更新，不能将其归为本次实现修改。

没有修改任何已有适配器的实现，没有改数据库结构、遥测、实例设置或配置文件。没有运行 commit/push，没有增加署名。当前 HEAD 仍为 `e0a2f6025d63f6e1d2bf42717a5d4bd430496338`。

与修改前完整源码清单比较，除白名单内文件及规格更新外，只观察到运行中服务自行追加的 `.paperclip/windows-logs/stdout.log`、`stderr.log` 发生变化；没有为消除差异而修改或回滚它们。详见 [源码边界核对](2026-10-25-member-agent-phase1-evidence/source-boundary-audit.json)。14 个本次源码文件的哈希见 [文件清单](2026-10-25-member-agent-phase1-evidence/changed-source-files.json)。

## 改动前失败清单及改动后对照

相关测试基线：8 个文件、129 项通过、0 项失败，退出码 0；因此本次相关测试的“改动前失败清单”为**空**。

原有用例分布：live-events-ws 8、registry 35、adapter-registry 22、agent-auth-jwt 17、heartbeat-runtime-mcp-servers 12、heartbeat-direct-adapter-native-isolation 4、run-lifecycle 17、recovery 14。

改动后：同样 8 个原有文件加新 protocol 测试，共 9 个文件、163 项通过、0 项失败，退出码 0。逐个用例名称核对：129 项原有用例全部保留并通过，缺失 0，回归失败 0；新增 34 项通过（protocol 33，注册表 1）。逐条前后结果见 [129 项对照清单](2026-10-25-member-agent-phase1-evidence/test-case-comparison.json)。live-events-ws 原有 8 项全部通过，额外隔离测试验证旧查询 Key 兼容及跨公司拒绝。

递归 typecheck 的两处既有环境失败按决定 10 保留，未修复：

- 默认 Windows shell 不能执行 shared build 中的 `mkdir -p` / `cp`，退出码 1。
- 仅在检查进程改用 Git Bash 后，`packages/paperclip-runner/scripts/check-runner-workflow-traceability.mjs:5` 的 Windows 绝对路径动态导入报 `ERR_UNSUPPORTED_ESM_URL_SCHEME`，退出码 1。

正式验收改用包内 `pnpm exec tsc --noEmit`：server、packages/shared、ui 改动前均退出 0、错误 0；改动后均退出 0、错误 0，新增错误 0。见 [类型检查对照](2026-10-25-member-agent-phase1-evidence/typecheck-comparison.json)。过程中曾因认证抽取时遗漏仍被使用的 import 产生 5 条 TS2304，已恢复 import；失败输出保留，不能误记为基线问题。

## 运行过的命令与完整输出

所有链接均包含完整 stdout/stderr，不截掉失败。工作目录除另述外为 `D:/paperclip/server`。测试只使用临时嵌入式 Postgres 和随机回环端口。

相关基线命令：

```powershell
node ../node_modules/vitest/vitest.mjs run --config vitest.config.ts --reporter=verbose --cache=false src/__tests__/live-events-ws.test.ts src/adapters/registry.test.ts src/__tests__/adapter-registry.test.ts src/__tests__/agent-auth-jwt.test.ts src/__tests__/heartbeat-runtime-mcp-servers.test.ts src/__tests__/heartbeat-direct-adapter-native-isolation.test.ts src/services/heartbeat/run-lifecycle.test.ts src/services/heartbeat/recovery.test.ts
```

最终回归命令：

```powershell
node ../node_modules/vitest/vitest.mjs run --config vitest.config.ts --cache=false --reporter=verbose src/adapters/member-agent/protocol.test.ts src/__tests__/live-events-ws.test.ts src/adapters/registry.test.ts src/__tests__/adapter-registry.test.ts src/__tests__/agent-auth-jwt.test.ts src/__tests__/heartbeat-runtime-mcp-servers.test.ts src/__tests__/heartbeat-direct-adapter-native-isolation.test.ts src/services/heartbeat/run-lifecycle.test.ts src/services/heartbeat/recovery.test.ts
```

- [改动前测试完整输出](2026-10-25-member-agent-phase1-evidence/baseline-tests.log)：129 通过，退出 0。
- [RED 测试完整输出](2026-10-25-member-agent-phase1-evidence/red-tests.log)：实现前新增模块不存在、名单预期不匹配，18 失败、34 通过，退出 1。调用方式为同一 Vitest 命令选择 registry.test.ts 和 protocol.test.ts。
- [首次实现测试完整输出](2026-10-25-member-agent-phase1-evidence/new-tests-attempt1.log)：14 失败、46 通过，退出 1。首次临时数据库启动超出首用例时限，后续用例连接 URL 未就绪；修正为 beforeAll 启动并正确等待预期的认证拒绝。
- [第二次测试完整输出](2026-10-25-member-agent-phase1-evidence/new-tests-attempt2.log)：60 通过，退出 0。上述 Vitest 命令选择 protocol.test.ts、registry.test.ts、live-events-ws.test.ts。
- [扩展测试完整输出](2026-10-25-member-agent-phase1-evidence/new-tests-attempt3.log)：28 通过，退出 0。上述命令仅选择 protocol.test.ts；之后又补充了取消等待上限、准备阶段挂起、旧接口兼容、限流等场景。
- [最终回归完整输出](2026-10-25-member-agent-phase1-evidence/regression-tests-attempt1.log)：163 通过，退出 0。
- [递归 typecheck 原始输出](2026-10-25-member-agent-phase1-evidence/baseline-typecheck.log)：根目录 `pnpm -r typecheck`，退出 1。
- [Git Bash 递归 typecheck 输出](2026-10-25-member-agent-phase1-evidence/baseline-typecheck-git-bash.log)：只为该进程设置 `npm_config_script_shell` 为 `D:/Program Files/Git/bin/bash.exe` 后运行同一命令，退出 1；没有改持久配置。
- 包内 `pnpm exec tsc --noEmit` 的前后完整输出： [server 前](2026-10-25-member-agent-phase1-evidence/before-tsc-server.log)、[server 中间失败](2026-10-25-member-agent-phase1-evidence/during-tsc-server.log)、[server 后](2026-10-25-member-agent-phase1-evidence/after-tsc-server-attempt1.log)；[shared 前](2026-10-25-member-agent-phase1-evidence/before-tsc-packages-shared.log)、[shared 后](2026-10-25-member-agent-phase1-evidence/after-tsc-packages-shared.log)；[ui 前](2026-10-25-member-agent-phase1-evidence/before-tsc-ui.log)、[ui 后](2026-10-25-member-agent-phase1-evidence/after-tsc-ui.log)。

最终回归输出末尾：

```text
Test Files  9 passed (9)
     Tests  163 passed (163)
  Start at  16:43:38
  Duration  233.84s (tests 68%, import 19%, transform 13%, setup 1%)
EXIT_CODE=0
```

没有运行全仓库 build/browser E2E；本轮按决定 10 的定向测试和包内类型检查口径验收，没有验证安装包或真实成员端。

## 九项验收逐条结论

下列行号均指 `server/src/adapters/member-agent/protocol.test.ts`，完整执行结果见最终回归日志。

1. **通过**：第 121 行，缺 Key、错 Key、撤销 Key、错误适配器，以及暂停、终止、仅 URL token 均被拒绝。
2. **通过**：第 129 行，同一智能体第二个连接收到 already_connected，原连接保持在线。
3. **通过**：第 137 行，离线 execute 立即返回 member_agent_offline，stderr 说明存在且不调用 onDispatch。
4. **通过（隔离服务集成）**：第 143、166 行，真实 WebSocket 传输 job.start / accepted / 两条日志 / result；真实 heartbeatService 使用临时数据库保存 succeeded、正确用量及结果，readLog 读回两条日志。它验证看板依赖的服务与持久数据，不代表打开现有业务看板做过人工端到端验收。测试在临时数据库将自身 fixture 任务结束，避免触发现有任务自动续跑规则；未连接生产。
5. **通过**：第 199 行，实际等待五秒，未 accepted 则失败；不是只调用一个伪造失败回调。
6. **通过（可控时钟边界）**：第 208 行，停止消息后调用与连接服务共用的 45,000ms sweep，运行返回 member_agent_disconnected；生产消息处理另有每次更新的 45 秒真实定时器。未用真实机器休眠或断网替代测试。
7. **通过**：第 216 行，AbortSignal 触发后假代理收到 job.cancel，结果为 cancelled。第 288 行另用真实约 30 秒等待验证 graceSec=20 加 10 秒后无结果也能结束。
8. **通过**：第 224 行，A 的有效连接不能被 B 的 companyId 查找到或收到其任务；第 308 行另验证旧实时接口的跨公司 Key 拒绝。
9. **通过**：第 229 行，完整及跨块运行 token、工具 token、智能体 Key 回显均被脱敏，覆盖日志、meta、错误、JSON 值及属性名。第 166 行真实 heartbeat 读回记录、日志和事件后，检索不到完整运行 token/Key。

其他通过场景包括：缺少令牌/历史/非法配置、单任务原子占位、未知版本/二进制/超大帧/非法结果字段、未知 type 忽略、其他 jobId 忽略、总时长、准备回调挂起也有界、同智能体多 Key 共用失败限流、local_trusted 不启用、JWT 至少八小时，以及缺身份环境检查的规定 warn。

## 实现说明与未确认边界

任务包按白名单组装，不原样序列化 ctx；不交付 agentIdentity 私钥、函数或任意服务器命令配置。`runtimeTools` 交付端点、令牌及过期时间；没有摘要明确失败，摘要上限 24,000 UTF-8 字节。成员模型由本机决定，服务器不传模型配置。版本固定为 0.160.0，同步目录为空，设置未持久化。

令牌及 Key 只用于内存连接和当前分发，不增加数据库列或持久化注册；输出脱敏复用内存 redactor。测试使用自造 Key/JWT，不读取个人登录凭据。工具 token 一小时过期且不续期；native MCP 发现、resources/prompts、managed gateway 自动配置未实现。

测试日志有 `runtime connection tools could not be delivered` 警告：隔离实例未配置连接工具的完整服务条件。适配器交付 ctx.runtimeTools 的路径由显式 fixture 覆盖，不能由该测试推断真实外部连接已打通。

对于成员已经开始工作但随后未确认接收、协议失败或回调失败的场景，本期按规格返回失败并清理槽位，没有证明成员本机进程已终止；不能把服务端结束视为本机停止。真实进程树终止仍需阶段 4 证据。

## 偏离本规格的地方

- 3100 的源码热重载风险未在编辑前识别；已观察到进程变化，不能声称满足“不重启”要求。未执行人工重启命令不能抵消这个事实。
- 第 10 节公网明文连接限制尚未落实，见文档开头。该项不在九项自动化清单中，但仍属于必须满足的规格。
- 其余实现限定在批准文件内。没有擅自改现有适配器、增加配置来源、数据库表、遥测或启动成员端下一阶段。

## 遇到但未解决的问题

上述公网传输限制及安全开发目录安排；3100 自动重载是否影响当时业务运行**未确认**，本轮未查询或改变业务任务来推断无影响。当前健康状态为 ok，部署仍为 local_trusted，新成员入口因此禁用。观察证据见 [运行服务核对](2026-10-25-member-agent-phase1-evidence/live-service-observation.json)。

## 下一阶段需要负责人确认的事项

先在不触发业务服务重载的隔离目录修复本阶段剩余缺口并重新验证，再做阶段 1 二次审查；收到确认后才进入阶段 2。成员 Windows 真实代理、Codex 调用、真实任务评审、进程树取消、frp 30 分钟、升级安装和两成员并行仍未执行，不宣称可用。
