# 成员代理阶段 2 实施与验证报告

日期：2026-10-25（Asia/Shanghai）。

阶段：2（Windows 常驻代理骨架与 echo 执行器）。

代码实现和规定的 18 类自动化场景已完成：5 个测试文件、126 项通过，成员端类型检查退出 0；阶段 1 的协议和两组注册表测试共 97 项通过。真实专用服务器 A1–A8 未执行，交由负责人按 acceptance.ps1 验收。**3100 前后实例一致的条件未通过，不能宣称本阶段所有验收已完成。**

## 改动文件与职责

仅在 `E:\workspace\paperclip-member-agent-dev\member-agent` 开发。独立仓库基线仍为 `92371b0ec3ae6c849f47225a040c92f1e79516be`，没有提交或推送；新文件仅使用 `git add -N` 以生成补丁。完整补丁文件列表见 patch-files.json。

- `member-agent/package.json`：独立私有 ESM 包，Node >=24.11.0，唯一依赖精确固定 ws 8.22.0。
- `member-agent/package-lock.json`：固定独立依赖内容与完整性。
- `member-agent/.gitignore`：排除独立 node_modules 与检查缓存。
- `member-agent/tsconfig.json`：只检查源代码，禁止不可擦除语法，不生成构建产物。
- `member-agent/vitest.config.ts`：隔离的成员端自动化测试入口。
- `member-agent/README.md`：中文配置、运行、自检、退出码与阶段边界说明。
- `member-agent/src/main.ts`：命令解析、自检、锁、连接与 Ctrl+C 协调。
- `member-agent/src/config.ts`：配置读取、一次汇总校验、环境 Key 优先及 Windows ACL 警告。
- `member-agent/src/transport-check.ts`：对照服务器地址范围实施客户端明文自检。
- `member-agent/src/connection.ts`：hello、独立心跳、原生 ping/pong 活性检测、拒绝处理与退避重连。
- `member-agent/src/outbound-queue.ts`：1000 帧/8 MiB 上限、仅丢弃旧日志、结果排空确认。
- `member-agent/src/protocol.ts`：帧、结果、meta、event、usage 的严格字段校验及 UTF-8 分块。
- `member-agent/src/job-runner.ts`：先确认任务，再启动执行器；单任务、独立序号、取消、超时、断线丢弃与一次结果。
- `member-agent/src/executor-worker.ts`：在独立 Worker 中加载执行器，保持网络线程响应。
- `member-agent/src/executors/types.ts`：保留 job、serverUrl、AbortSignal 的执行器接口与结果白名单类型。
- `member-agent/src/executors/echo.ts`：测试日志、令牌评论写回和测试专用 done PATCH，不启动外部工具。
- `member-agent/src/logger.ts`：同一流式脱敏器保护本机/控制台/上送输出，按日滚动并清理七天前日志。
- `member-agent/src/lock.ts`：原子发布 PID 锁，拒绝活进程并恢复陈旧锁。
- `member-agent/src/process-tree.ts`：通过 execFile 调用 Windows taskkill 整树终止，并确认 PID 消失。
- `member-agent/test/foundation.test.ts`：配置、传输、脱敏、ACL、锁和 Windows 子孙进程测试。
- `member-agent/test/protocol-echo.test.ts`：协议严格字段、UTF-8 和随机回环 HTTP 写回测试。
- `member-agent/test/connection.test.ts`：随机回环 WebSocket、时钟注入、重连、心跳、队列和排空测试。
- `member-agent/test/job-runner.test.ts`：执行器 Worker、单任务、取消、超时、断线丢弃与异常收尾测试。
- `member-agent/test/cli.test.ts`：命令退出码、原生 Node 类型剥离和双次 Ctrl+C 测试。
- `member-agent/test/fixtures/executor.ts`：测试专用阻塞、等待、错误、假令牌与遗留句柄执行器。
- `member-agent/test/fixtures/process-tree.mjs`：测试专用子进程与孙进程夹具。

成员端 node_modules 是真实独立目录，非联接；安装使用 `npm install --prefix <副本>/member-agent --workspaces=false --ignore-scripts --no-audit --no-fund`，没有经 D 盘 node_modules 联接安装依赖。没有修改服务器、共享类型或数据库；既有 test.ts、protocol.test.ts 及先前阶段的修复都不包含在阶段 2 补丁中。

## 运行过的命令与完整输出

成员端工作目录为 `E:\workspace\paperclip-member-agent-dev\member-agent`：

```powershell
node ..\node_modules\vitest\vitest.mjs run --config vitest.config.ts --cache=false --reporter=verbose
pnpm exec tsc --noEmit
node .\src\main.ts version
```

完整最终输出：[all-tests-final.log](all-tests-final.log)（126 通过、退出 0）、[member-typecheck-final.log](member-typecheck-final.log)（0 个诊断、退出 0）。原生 Node 实测为 24.18.0；version 打印 0.1.0，main、模块以及执行器 Worker 均由 Node 原生类型剥离运行，无构建步骤。

阶段 1 回归工作目录为副本 server：

```powershell
node ..\node_modules\vitest\vitest.mjs run --config vitest.config.ts --cache=false --reporter=verbose src/adapters/member-agent/protocol.test.ts src/adapters/registry.test.ts src/__tests__/adapter-registry.test.ts
```

完整输出：[phase1-regression.log](phase1-regression.log)，3 个文件 97 项通过：协议 39、registry 36、adapter-registry 22，失败 0。没有更改这三个测试文件。

所有中间失败和通过输出均保留在本目录，不只保留最后的成功：

- `runner-red.log`、`cli-red.log`、`protocol-echo-red.log`、`foundation-red.log`、`connection-red.txt`：测试先行时目标模块缺失。
- `foundation-red-behavior.log`、`foundation-guard-red.log`：基础行为与陈旧锁恢复反例。
- `foundation-url-red.log`：原 URL 归一化会放过 `/path/..` 与 `/.`，已改为校验输入原文。
- `foundation-diagnostic-red.log`：Key 与诊断字段相同时诊断输出也须脱敏，已修正。
- `protocol-echo-record-red.log`：严格记录类型反例，已修正。
- `connection-red-all.txt`、`connection-red-behavior.txt`：退避和连接策略实现前的失败。
- `connection-liveness-red.txt`：无原生 pong 的半开连接反例，已用独立 45 秒 pong 截止时间修正。
- `connection-drain-red.txt`：队列未排空时不能确认优雅退出，已补最多 5 秒 drain 和发出回调确认。
- `all-tests-attempt1.log`：117 通过、1 失败，Ctrl+C 测试只等待固定微任务轮次；改为等实际回调。
- `all-tests-attempt2.log`：119 通过、2 失败，为正在补充的上述 URL 归一化反例；最终正确拒绝。
- `all-tests-attempt3.log`：124 通过；随后追加结果排空场景。
- `all-tests-final.log`：最终 126 通过，失败 0。

各单模块 RED/GREEN 的其余 `*.log`、`*.txt` 也完整保留。dependency-install.log 记录唯一依赖的独立安装。没有运行全仓构建、发布或真实服务器测试。

## 18 项自动化验收逐条结论

下列测试名均可在最终完整输出逐条检索；一项规格由多条参数化测试覆盖，所以总计 126，不是只有 18 条断言。

1. **通过**。foundation 的 `#1 配置校验`：缺字段、类型错、未知字段、非法源地址、环境 Key 优先、多错误一次列全；含 BOM 和权限检查。
2. **通过**。foundation 的 `#2 明文自检`：HTTP 公网拒绝、HTTPS 通过，全部规定的 IPv4/IPv6/Tailscale 边界及映射 IPv4、无点号主机名覆盖。
3. **通过**。connection 的 `发送有效 hello 和认证头，check 在 ack 后读取服务器参数并正常退出`、`10 秒未收到 hello 响应就关闭，1 秒退避后重连`、`HTTP 401/403 退出码 3/4 且不重试`、`HTTP 429 至少等 60 秒才重试`。注入时钟，不真等 60 秒。
4. **通过**。`already_connected 每次等 30 秒无限重试，not_allowed 不重试`；旧连接不被新连接替换。
5. **通过**。`失败指数退避到 30 秒上限，ack 后重置`、`随机抖动在 0–20%，独立心跳按 ack 周期发送`。
6. **通过**。`6 执行器在独立 Worker 中同步忙等时，真实 WebSocket 心跳持续发送`；真实回环连接在执行器忙等两秒时收到多次心跳。另有无 pong 45 秒断线、正常 auto-pong 超过 60 秒仍在线的可控时钟验证。
7. **通过**。`7 accepts before preparation, numbers logs and events independently, and emits one result`，以及 `7 settles a returned result even when the executor left a live timer`；echo HTTP fixture 验证 UTF-8 评论与 done 写回。
8. **通过**。`8 refuses a second job without affecting the running task`，第二任务只返回 busy，不接受、不影响原任务。
9. **通过**。`9 cancellation ends within grace and ignores foreign cancellation`、`9 forcibly stops a synchronous blocked executor within grace`、`9 releases a task when local logging fails before worker creation`。
10. **通过**。`10 enforces a local maxRunSec and aborts the executor`，本机计时触发取消与 timedOut，不依赖服务端超时。
11. **通过**。`11 discards disconnected task output and never replays results through a new sender`，以及原生 pong 失联测试中实际取消 runner 再重连；旧 session sender 失效。
12. **通过**。protocol-echo 中 `chunkUtf8` 的空文本、边界、多字节和超长文本测试；每块不超过 32 KiB，重组与原文相同。
13. **通过**。`13 turns an unknown executor result field into a protocol safe failure`，以及协议对 result/meta/event/checkpoint 顶层和嵌套白名单的参数化反例。
14. **通过**。foundation 的 `#14 同一脱敏器保护控制台和日志` 覆盖整串、任意分块、JSON 键/值和 URL；runner 的 `14 scans console, log files and all outgoing frames for every fake credential` 对三处检索 Key、运行/工具令牌；另覆盖 JSON 特殊字符与长异常的令牌前缀。
15. **通过，Windows 实跑，无跳过**。`taskkill 确实终止测试子进程及孙进程`；终止前两者存在，execFile taskkill 后两者都不存在。echo 自己不启动子进程；未来启动外部工具的执行器必须另接入进程所有权，不能把 Worker 终止当成整个外部进程树已停止。
16. **通过**。`活进程锁拒绝且退出码 5；释放后可以重新获取`、`陈旧锁被覆盖；并发申请只允许一个成功`、`崩溃留下的陈旧获取锁也可恢复，活进程获取锁不会被删除`。
17. **通过**。`17 first Ctrl+C drains before closing, second Ctrl+C forces exit`、`17 first Ctrl+C gracefully closes after a completed cancellation`；队列 drain 另验证有在途日志时结果发送回调完成才排空，失败/超时明确返回 false。
18. **通过**。`超过1000帧只丢弃最旧日志，保留结果且发送回调继续排空`、`8MiB 字节上限生效，停止后丢弃后续输出`、`ws 缓冲区积压时暂缓发送，并在缓冲释放后恢复`。只淘汰旧 job.log；主动退出先等结果排空，超时明确提示未送达。

## 类型检查前后对比

开始前没有 member-agent 包，不能把不存在的包宣称为已跑过的基线。最早完整成员端类型检查 `member-typecheck-attempt1.log` 为 0 个错误；最终 `member-typecheck-final.log` 同样为 0 个错误，新增 0。子模块的类型检查原始输出也保留；未修改既有包，因此没有为本阶段修改服务器/共享/UI 类型或递归构建流程。

## 真实服务器 A1–A8

未执行，未登录或连接专用服务器。逐区块可粘贴命令见 [acceptance.ps1](acceptance.ps1)，PowerShell AST 语法解析通过；没有执行其中的网络命令。配置示例无 Key，真实 Key 仅由不回显提示放进进程环境，不要求贴回。

A1 check、A2 常驻在线、A3 单次 succeeded/done/评论作者及 60 秒后无第二次运行、A4 读回日志、A5 运行中一次 Ctrl+C、A6 运行中关窗口并观察 45 秒、A7 假 Key 退出 3、A8 两客户端同 Key 均有独立区块。A5/A6 只有在任务确实仍 running 时操作才算有效；echo 很快，已结束后再关闭必须重做，不能虚报通过。A4 的真实运行令牌不可索取；完整泄露检索使用自动化测试里的明显假值完成。

## 补丁与适用范围

补丁：`D:\paperclip\doc\plans\2026-10-25-member-agent-phase2-evidence\phase2.patch`。

生成方式：`git add -N -- member-agent` 后执行 `git diff --binary HEAD -- member-agent`，保留原始输出字节。只包含 member-agent 下 26 个新文件，不含 node_modules、证据日志、任何 server 文件或 test.ts/protocol.test.ts 既有修复。独立依赖目录未进入补丁。

验证目录：`E:\workspace\paperclip-member-agent-phase2-applycheck`，从隔离仓库基线用 `git clone --local --no-hardlinks` 建立，验证前工作区干净；只执行 `git apply --check`，退出码 0，见 apply-check.log。没有对 D 盘执行 apply。D 盘写入仅限负责人明确要求的本阶段交付 evidence 目录。

## 3100 观察证据

见 service-observation.json。本轮开始实读：PID **24484**，processStartedAt **2026-10-25T10:38:03.613Z**，健康 ok；本轮结束实读：PID **36504**，processStartedAt **2026-10-25T12:03:57.742Z**，健康 ok。两者不同，**前后同一实例未通过**。此前阶段记录的 59752/08:43:51.466Z 在本轮开工前已不是当前实例。

本任务没有执行服务停止/重启命令，也没有编辑 D 盘源码；没有向运行中的业务派发或取消任务。实例变化的触发来源未确认，不据此猜测他人操作或认定测试导致。测试仅使用随机回环端口/临时目录；阶段 1 回归使用其临时测试数据库，成员端测试不导入服务器或数据库。

## 偏离本规格的地方

3100 前后实例一致的证据未满足，原因未确认，已单独标出。其余代码范围按阶段 2 细化规格与本次指令执行；没有实现阶段 3、打包、登录、自启或版本下载，没有启动 Codex。

## 遇到但未解决的问题

真实 A1–A8 结果尚缺负责人在专用服务器的实际观察；3100 实例变化来源未确认。不能以本地自动化通过代替这两项。

## 下一阶段需要负责人确认的事项

先审查本补丁并由负责人执行 A1–A8。阶段 3 开始前决定 Codex 适配器库如何交付到成员电脑；固定版本安装位置与阶段 6 自启方案继续保留，未提前制定打包方案。
