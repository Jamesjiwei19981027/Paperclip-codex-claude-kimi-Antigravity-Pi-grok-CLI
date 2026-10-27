# 成员代理阶段 2 小修报告

日期：2026-10-25（Asia/Shanghai）。

阶段：2（echoHoldSec 与验收脚本小修）。

本轮在 `E:\workspace\paperclip-member-agent-dev` 完成实现。成员端 **135 项通过**（原 126 项保留，新增 9 项）；阶段 1 协议及两组注册表 **97 项通过**；成员端类型检查 **0 → 0** 个错误。已覆盖生成阶段 2 补丁，干净临时副本 `git apply --check` 退出 0。没有把补丁应用到 D 盘。

## 改动文件与行号

以下源码路径均相对隔离副本；只有交付证据写入指定的 D 盘 evidence 目录，未编辑 D 盘源码。

- `member-agent/src/config.ts:15`、`:32`、`:51`：定义并允许 echoHoldSec，默认 0，只接受 0–600 的整数；非法值汇总为带字段名的中文诊断，未知字段仍拒绝。
- `member-agent/src/main.ts:38`：将校验后的本机 echoHoldSec 传给 JobRunner。
- `member-agent/src/job-runner.ts:17`、`:38`：把本机测试延时放入既有 Worker 的 workerData；不改变服务器任务包或协议字段。
- `member-agent/src/executor-worker.ts:11`：从 workerData 创建测试 echo 执行器；保留原有测试夹具执行器加载方式。
- `member-agent/src/executors/echo.ts:15`、`:24`、`:33`：新增可取消等待，收到任务日志后等待，再写评论和状态；取消会清除计时器、移除监听并返回 cancelled，等待之后重新检查取消信号。工厂默认延时为 0，原 echoExecutor 导出继续可用。注释明确该选项仅用于测试、真实执行器不得使用。
- `member-agent/test/echo-hold.test.ts:28`：仅新增测试文件，没有修改、删除原有五份测试文件中的 126 项。
- `member-agent/README.md:44`、`:55`：说明测试专用延时与进程树尚未接线的风险。
- `acceptance.ps1:18`：403 输出“该读回由负责人在看板或浏览器会话中完成”，不误报自动验收失败或成功；非 403 错误继续抛出。
- `acceptance.ps1:44`、`:65`：A3/A4 在读回被拒绝时转交负责人，避免空返回值继续进入断言或日志分页。
- `acceptance.ps1:77`、`:93`：A5/A6 配置 echoHoldSec=60 后重新运行；给出可直接粘贴的配置修改、启动和验收后恢复 0 的步骤。重写配置前移除 agentKey，Key 始终从进程环境提供。

## 新增测试名称与完整输出

完整新增测试输出：[echo-hold-green.log](echo-hold-green.log)；完整首次失败：[echo-hold-red.log](echo-hold-red.log)。RED 为 8 失败、1 通过，复现未知配置字段、缺少工厂及未传入延时的行为；实现后新增 9 项全部通过：

1. `defaults to zero and preserves immediate echo writeback`：默认 0，原先即时 POST/PATCH 行为一致。
2. `rejects invalid echoHoldSec -1 with a Chinese field diagnostic`。
3. `rejects invalid echoHoldSec 601 with a Chinese field diagnostic`。
4. `rejects invalid echoHoldSec 1.5 with a Chinese field diagnostic`。
5. `rejects invalid echoHoldSec abc with a Chinese field diagnostic`。
6. `accepts both endpoints and still rejects unknown configuration fields`：0、600 允许，拼错字段仍拒绝。
7. `cancels a 30 second hold in under one second without any writeback`：取消结果为 cancelled，耗时小于 1 秒，fetch 一次也未调用。
8. `waits two seconds before normal writeback with an injected clock`：用可控时钟推进，1999ms 时没有请求，2000ms 后正常 POST/PATCH；不真实等待两秒，计时器清理完毕。
9. `passes the local hold through workerData and cancellation prevents worker writeback`：真实 Node Worker 收到本机延时，先输出日志、保持未结束，取消在一秒内完成；没有误执行写回。

原五份测试文件和上一版已交付补丁中的内容逐一比较相同。由于临时 Git 检出自动使用 CRLF，比较时只统一换行符，未做其他归一化；见 [echo-hold-original-tests-unchanged.json](echo-hold-original-tests-unchanged.json)。

## 运行过的命令与完整输出

成员端工作目录：`E:\workspace\paperclip-member-agent-dev\member-agent`。

```powershell
node ..\node_modules\vitest\vitest.mjs run --config vitest.config.ts --cache=false --reporter=verbose test/echo-hold.test.ts
node ..\node_modules\vitest\vitest.mjs run --config vitest.config.ts --cache=false --reporter=verbose
pnpm exec tsc --noEmit
```

新增测试先 RED 后 GREEN，完整输出见上一节。全部成员端测试完整输出：[echo-hold-all-tests.log](echo-hold-all-tests.log)：

```text
Test Files  6 passed (6)
     Tests  135 passed (135)
EXIT_CODE=0
```

类型检查在产品代码修改前后分别运行相同命令；[echo-hold-typecheck-before.log](echo-hold-typecheck-before.log)、[echo-hold-typecheck-after.log](echo-hold-typecheck-after.log) 均退出 0，无 TypeScript 错误，新增错误为 0；两次都有同样的既有 pnpm 配置字段提示，不作为类型错误隐藏。

阶段 1 回归工作目录：`E:\workspace\paperclip-member-agent-dev\server`。

```powershell
node ..\node_modules\vitest\vitest.mjs run --config vitest.config.ts --cache=false --reporter=verbose src/adapters/member-agent/protocol.test.ts src/adapters/registry.test.ts src/__tests__/adapter-registry.test.ts
```

完整输出：[echo-hold-phase1-regression.log](echo-hold-phase1-regression.log)：3 文件 97 项通过，退出 0；协议 39、registry 36、adapter-registry 22，失败 0。测试只使用各自的临时数据库和随机回环端口，没有连接业务实例。

验收脚本只做 AST 语法解析及函数级假 HTTP 错误验证，没有执行其真实网络步骤：[echo-hold-acceptance-validation.log](echo-hold-acceptance-validation.log)。结果为语法通过、403 正确转交负责人、非 403 正确传播错误。实际服务器 A1–A8 没有在本轮执行。

## 验收项逐条结论

- **通过**：echoHoldSec 的默认值、上下界、整数/类型校验和未知字段拒绝。
- **通过**：等待位置在收到任务日志之后、写回之前；等待期间取消迅速返回 cancelled 且不写回。
- **通过**：通过本机配置 → JobRunner → workerData → echo 工厂传递，不读全局配置状态、不改变服务器协议、不新增依赖。
- **通过**：原 126 项未删改，新增 9 项与完整成员端测试均通过。
- **通过**：阶段 1 的 39 项协议测试及两组注册表测试无回归；类型检查新增错误 0。
- **通过**：A5/A6 已提供 60 秒窗口及配置修改步骤；A3/A4 的 403 明确转交负责人；脚本不把真实 Key 写入文件或命令参数。
- **通过**：补丁只包含 member-agent 下的 27 个文件，不含任何服务器端已知修复；干净临时副本应用检查通过。
- **通过**：本轮 3100 的监听 PID 与只读 health 中的 processStartedAt 前后一致，见下节。
- **未执行**：真实服务器 A1–A8，按本轮禁止连接/写入专用服务器的约束交由负责人完成。

## 3100 的前后对比

本轮首先从本机系统接口确认监听 PID 36504。负责人明确允许仅对 `/api/health` 进行两次只读请求后，补采首次 health 并在结束时再次核对：

- 首次：PID **36504**；processStartedAt **2026-10-25T12:03:57.742Z**；健康 **ok**。
- 结束：PID **36504**；processStartedAt **2026-10-25T12:03:57.742Z**；健康 **ok**。
- 两次实读值均与负责人本轮提供的基线一致；没有推断上轮重载原因。

证据：[echo-hold-service-before.json](echo-hold-service-before.json)、[echo-hold-health-before.json](echo-hold-health-before.json)、[echo-hold-health-after.json](echo-hold-health-after.json)、[echo-hold-service-comparison.json](echo-hold-service-comparison.json)。未重启或停止服务，未派发或取消业务任务。

## 补丁路径与检查结果

交付补丁：`D:\paperclip\doc\plans\2026-10-25-member-agent-phase2-evidence\phase2.patch`，覆盖旧版。基线提交仍为 `92371b0ec3ae6c849f47225a040c92f1e79516be`。

新文件使用 `git add -N` 后，以 `git diff --binary HEAD -- member-agent` 重新生成原始字节补丁。相对上轮完整阶段 2 补丁，只修改本报告列出的成员端代码与 README，并新增一个测试文件；没有包含 server/test.ts、server/protocol.test.ts 或其他服务端修复。acceptance.ps1 和完整日志作为 evidence 单独交付，不混入源码补丁。

干净临时验证副本：`E:\workspace\paperclip-member-agent-echo-hold-applycheck`，从隔离仓库基线克隆，无依赖、无初始工作区改动；执行 `git apply --check` 退出 0，见 [echo-hold-apply-check.log](echo-hold-apply-check.log)。没有对 D 盘执行 apply，没有提交或推送。

## 进程树已知风险（只记录，不实现）

**process-tree.ts 目前没有被运行代码调用，只有独立单元测试直接调用。阶段 3 必须让执行器把子进程号登记给 job-runner，由 job-runner 在取消、超时、连接断开时统一终止进程树。执行线程被 terminate() 时，线程里启动的子进程不会随之结束，这是已知风险。**

本次没有接线，没有增加子进程登记接口，也没有把 Worker 终止等同于外部进程树终止。echo 仍不启动任何子进程。

## 偏离本规格的地方

无。本次 echoHoldSec 扩展依据本轮明确指令，不将旧配置白名单视为阻止该扩展；health 只读核对也获得了本轮明确允许。

## 遇到但未解决的问题

进程树尚未接线，按要求只记录；真实 A1–A8 仍需负责人执行。代码、测试和补丁检查没有未解决失败。

## 下一阶段需要负责人确认的事项

审查更新补丁并执行 A5/A6 等真实验收。阶段 3 再实现子进程登记和统一清理，并决定 Codex 库的成员端交付方式；本轮没有提前实现。
