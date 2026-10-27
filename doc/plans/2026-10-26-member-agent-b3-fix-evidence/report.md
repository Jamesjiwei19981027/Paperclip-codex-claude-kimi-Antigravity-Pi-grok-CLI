# 阶段 3：B3 停止确认修复

日期：2026-10-26（Asia/Shanghai）。

阶段：3，接续真实服务器 B3 验收中断后的隔离修复。负责人已明确批准仅在 E 盘修改成员代理服务端适配器及必要测试，交付独立补丁，不修改 D 盘、不部署、不重启服务。

本次代码修复与自动化回归通过；**本机 3100 前后一致条件未通过**。工作前 PID 36504、健康状态 ok；收尾时该进程已不存在，3100 无监听，health 请求连接被拒绝。负责人随后确认刚才重启了计算机，这解释了原进程退出及 3100 无监听；没有执行停止或重启服务命令，D 盘状态前后相同。本报告不将这一项记为通过，也不自行恢复服务。

## 接手位置与根因

本次读取 Claude 会话 `6ab6046d-dde6-4102-b82b-75f1fdc0f02b` 的最新记录，确认中断点是 BOS-7 的运行中取消，不是重新实现阶段 3。恢复出的必要事实保存在 [recovered-acceptance-context.json](recovered-acceptance-context.json)。本次没有沿用对话里的浏览器执行权限去操作专用服务器，也没有复制任何登录凭据。

- B2 为 Claude 此前报告通过，工单 BOS-6。本次没有重新验证该远程结果；假模型引发自动续跑等限制保持原记录，不把 B2 当成真实账号 S 系列验证。
- B3 工单 BOS-7：`24901318-021e-43ca-9edf-ce8d619b8928`，运行 `10cd2ac8-ee39-4640-b491-c0e740188a19`。
- Claude 在 `2026-10-26T06:13:14.765Z` 发出取消。保存的接口返回为 HTTP 409：`Execution ended, but provider termination could not be verified. Inspect the stopped run before continuing.`；同次运行读回为 `cancelled`，结束于 `06:13:31.186Z`。
- 本机成员日志在 `06:13:35.466Z` 记录该运行 `cancelled`；原固定版本 Codex PID 18508 已不在当前进程列表。本机与服务器的时钟差未校验，不用两边时间直接推导跨机器清理耗时。
- Claude 最后准备执行的暂停智能体操作被用户拒绝，没有成功回执。本次没有重试暂停，也没有改动远程智能体/工单状态。

代码因果链：

1. `server/src/services/heartbeat/run-control.ts:1015` 对没有服务器本机 PID 的运行写入 `executionCancellation.state=requested` 并等待适配器结束。
2. 修复前 `server/src/adapters/member-agent/execute.ts` 只把成员 `job.result` 转为 `cancelled`，没有生成服务器停止确认；还会覆盖成员的进程树清理失败诊断。
3. `server/src/services/heartbeat/run-completion.ts:543` 将适配器结果与已有取消元数据合并保存。没有新的停止确认时，已有 `requested` 状态保持原样。
4. `server/src/services/heartbeat/run-control.ts:1071` 明确要求停止确认是 `acknowledged`，否则即使运行已经 `cancelled` 也返回上述 409。

本次在随机回环端口、临时数据库中通过真实 heartbeat 取消链路重现了相同 409，见 [red-tests.log](red-tests.log)，并非仅凭源码推测原因。

## 改动文件

产品源码与新增测试只有两份，均在 `E:\workspace\paperclip-member-agent-dev`：

- `server/src/adapters/member-agent/execute.ts:79`：生成绑定公司、智能体、运行编号及服务器时间的停止确认。
- 同文件第 91 行：取消发生在远程任务尚未下发时，记录 `member_agent_not_dispatched`；不存在远程任务时由服务器自身证明未启动。
- 同文件第 134 行：丢弃成员原样回传的 `resultJson.executionCancellation`，不接受成员自行夹带服务器确认。
- 同文件第 143 行：只在已有取消请求、收到当前任务的有效终结结果，且结果为 `cancelled` / `exitCode=1` / `signal=null` / `timedOut=false` 时生成 `member_agent_stop_result`。阶段 3 的成员 JobRunner 在 worker 与登记进程树清理完成后才发送该结果。
- 同文件第 144 行：进程树清理失败或执行器错误保留原错误码和诊断，不冒充已确认停止。成功结果与取消竞争、断线、等待超时均不给予确认。
- `server/src/adapters/member-agent/cancellation.test.ts:86`：新增真实 WebSocket、临时数据库与 heartbeat 取消回归测试。

没有修改通用 heartbeat 取消代码、服务器协议、数据库结构、现有适配器、成员代理源码、依赖或遥测。已有 `protocol.test.ts`、`test.ts` 中负责人先前做的修复保持原样。独立补丁不包含任何阶段 1/2/3 旧改动。

## 新增测试逐条结论

最终结果由下节的完整回归输出确认，新增九个 case 分别为：

1. `records a server-owned acknowledgement only after the matching cancellation result`：当前任务有效取消后生成服务器确认，绑定运行与智能体，确认时间可解析。
2. `never acknowledges member_agent_process_tree_termination_failed or loses its diagnostic during cancellation`：清理失败不确认，保留错误；即使夹带伪造确认也被删除。
3. `never acknowledges member_agent_executor_error or loses its diagnostic during cancellation`：执行器失败同样不确认，保留错误。
4. `does not let an ordinary result forge a server stop acknowledgement`：普通成功结果夹带的确认被删除，其他任务输出保留。
5. `acknowledges cancellation before dispatch without sending a remote job`：任务尚未下发就取消，无 `job.start`，生成未下发证明。
6. `does not acknowledge a success result racing an operator cancellation`：成功结果与取消竞争，不推断停止确认。
7. `does not acknowledge a disconnected member after sending cancellation`：取消后断线，不推断确认。
8. `full heartbeat cancel contract: clean stop`：真实 heartbeat 取消服务成功返回，数据库持久化服务器确认，修复 BOS-7 对应的 409。
9. `full heartbeat cancel contract: cleanup failure`：真实取消服务仍返回 409，持久化状态保持 `requested`，伪造确认无法越过检查。

## 运行过的命令与完整输出

所有测试使用副本、临时数据库和随机回环端口，未连接专用服务器。Key 与签名密钥均为标明 FAKE 的测试值，没有读取真实 `auth.json`。

修改前基线：

```powershell
# 工作目录：E:\workspace\paperclip-member-agent-dev\server
node ../node_modules/vitest/vitest.mjs run --config vitest.config.ts --cache=false --reporter=verbose src/adapters/member-agent/protocol.test.ts src/adapters/registry.test.ts src/__tests__/adapter-registry.test.ts
pnpm exec tsc --noEmit
```

[baseline-tests.log](baseline-tests.log)：3 文件、97 项通过，退出码 0。[server-tsc-before.log](server-tsc-before.log)：退出码 0，无 TypeScript 错误。

先写测试再修改实现：[red-tests.log](red-tests.log) 为 5 失败、2 通过，包含与真实服务器相同的 409，以及伪造确认未过滤和失败诊断被覆盖；[red-before-dispatch.log](red-before-dispatch.log) 为未下发取消缺少确认的失败。修复后首轮 [green-tests.log](green-tests.log) 为 8 项通过；随后补充了完整 heartbeat 清理失败拒绝确认用例。

第一次扩大回归同时运行了服务端、成员端和类型检查，期间测试工作进程异常退出，类型检查也中断。完整输出保留在 [regression-tests.log](regression-tests.log)、[member-regression.log](member-regression.log)、[server-tsc-final.log](server-tsc-final.log)。日志出现退出码 1073807364、3221226091；负责人随后确认期间重启了计算机；这些输出保留为中断记录，不把它们算通过，也不据此推断每一个异常退出码的具体原因。随后依次执行各套测试，配置仍限制一个测试工作进程。

最终依次运行的命令：

```powershell
# server 目录；原九份回归文件，加本次 cancellation.test.ts
node ../node_modules/vitest/vitest.mjs run --config vitest.config.ts --cache=false --reporter=verbose --maxWorkers=1 src/adapters/member-agent/cancellation.test.ts src/adapters/member-agent/protocol.test.ts src/__tests__/live-events-ws.test.ts src/adapters/registry.test.ts src/__tests__/adapter-registry.test.ts src/__tests__/agent-auth-jwt.test.ts src/__tests__/heartbeat-runtime-mcp-servers.test.ts src/__tests__/heartbeat-direct-adapter-native-isolation.test.ts src/services/heartbeat/run-lifecycle.test.ts src/services/heartbeat/recovery.test.ts

# member-agent 目录
node ../node_modules/vitest/vitest.mjs run --config vitest.config.ts --cache=false --reporter=verbose --maxWorkers=1

# server、member-agent 各自目录分别执行
pnpm exec tsc --noEmit
```

- [regression-tests-retry.log](regression-tests-retry.log)：10 文件，178 项通过，退出码 0；新增 9 项通过，原有 169 项无回归。
- [member-regression-retry.log](member-regression-retry.log)：14 文件，201 项通过，退出码 0。成员端源码和原 135 项阶段 2 测试没有改动；真实 Codex 的回环假模型集成与 Windows 进程树测试均包含在该套件内。
- [server-tsc-retry.log](server-tsc-retry.log)：最终 server 检查退出码 0，对比修改前检查，新增 TypeScript 错误 0。
- [member-tsc.log](member-tsc.log)：成员端检查退出码 0。
- pnpm 的既有配置字段提示保持原样；测试中的不可用运行工具警告和 `unreadable intent` 错误路径输出保留在完整日志中，不作为新增测试失败隐藏。

## 补丁与范围核对

独立补丁：[b3-stop-confirmation.patch](b3-stop-confirmation.patch)，14,341 字节，SHA-256：

```text
725C01C3F773FA57BD5E84598EC05846C5D3401976E599E5841244CCC0BB680F
```

只包含 `server/src/adapters/member-agent/execute.ts` 与新增 `server/src/adapters/member-agent/cancellation.test.ts`。以 E 盘修改前快照建立临时 Git 索引；该快照与 D 盘当前 execute.ts 的 SHA-256 完全相同。新增测试在临时仓库先 `git add -N`，再用 `git diff --binary` 生成增量。没有重写隔离副本基线，也没有 commit 或 push。

独立临时副本验证：`git apply --check` 退出码 0，`git diff --check` 退出码 0；实际只在临时副本应用后，两份文件的 SHA-256 均与 E 盘实现相同。见 [patch-verification.json](patch-verification.json)。没有向 D 盘应用补丁，没有覆盖原 phase3.patch。

[source-boundary.json](source-boundary.json) 记录：D 盘 Git 状态前后均 124 行，差异 0；D 盘 execute.ts 内容不变，D 盘不存在新增 cancellation.test.ts；E 盘原 protocol.test.ts 与修复前快照相同。完整原始状态保存在 `d-status-before.txt` 与 `d-status-after.txt`。

## 验收项逐条结论

- **通过**：在隔离环境复现真实 409，并用完整 heartbeat 取消链路确认修复。
- **通过**：有效取消结果生成绑定本次运行的服务器确认；未下发任务的取消由服务器自身确认。
- **通过**：清理失败、执行器失败、成功与取消竞争、断线不给予停止确认；成员夹带的确认被剥离，错误诊断保留。
- **通过**：新增九项、原有 169 项服务端回归及 201 项成员端回归通过；类型检查新增错误为 0。
- **通过**：补丁仅两份文件、临时副本可干净应用、D 盘源码与 Git 状态未变。
- **未通过**：本机 3100 前后一致。收尾只读检查 health 连接拒绝，3100 没有监听，原进程不存在。负责人确认已重启计算机，故跨重启无法保持相同进程和启动时间，见 [health-comparison.json](health-comparison.json)。本次没有操作服务启停。
- **未执行**：部署后的真实服务器 B3 重跑；不把本地回归替代该项。原 BOS-7 的历史 409 和缺失停止确认没有被改写。

## 偏离本规格的地方

服务端适配器修复由本次负责人明确授权，是对阶段 3 原“禁止修改 server”范围的定向补充；没有扩大到通用 heartbeat、协议或数据库。没有其他已知代码范围偏离。本机服务前后一致未能满足，原因如上，不记为通过。

## 遇到但未解决的问题

- 收尾观察时本机 3100 不可访问；负责人随后确认重启了计算机。本次没有启动或重启该服务，恢复运行需另行安排。
- 专用服务器仍需要负责人应用并部署本独立补丁后重跑 B3。成员回报停止是现有可信代理协议的证据；服务端不能直接查看远程进程列表，真实验收仍须独立保存取消前后固定版本 Codex 及其子孙进程快照。
- BOS-7 的既有历史记录需要保留，不能补写“已确认停止”来掩盖当时失败。后续真实验证使用新工单/新运行，并控制假模型任务的自动续跑。
- 真实账号 S1–S8、技能版本耦合与跨服务器会话续接仍按原阶段 3 报告待负责人验证，没有在本轮提前实现。

## 下一步需要负责人

审查此独立服务端补丁并决定部署时机。部署后使用仍绑定独立 `codex-home-fake`、固定版本 Codex 和延迟假模型的代理重新执行 B3：同时确认取消接口正常返回、当前运行持久化 `executionCancellation.state=acknowledged` 且 proof 为 `member_agent_stop_result`，以及此前记录的测试 Codex 与子孙进程全部退出。不要停止桌面版 Codex 自身的进程。

