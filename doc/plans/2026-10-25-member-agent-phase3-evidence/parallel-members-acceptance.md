# 多成员并行与项目目录隔离补充验收

## 范围

补充验证两条联合开发路径：同一公司内的两个成员智能体同时执行不同任务；同一成员代理连续执行属于两个项目的任务时，各自使用配置的本机目录。所有测试在隔离副本中运行，服务器测试使用随机回环端口和临时数据库，没有连接 Paperclip 的 3100 实例或专用服务器。

## 改动

- `server/src/adapters/member-agent/protocol.test.ts`：允许测试夹具在同一公司下创建第二个成员；新增并行运行测试，检查不同项目上下文与 `jobId` 只发给对应连接，另一连接发送外来 `jobId` 时不会污染回调，日志和结果保持各自独立。
- `member-agent/test/codex-executor.test.ts`：新增双项目映射测试，连续运行两个项目任务并核对 `config.cwd`、`context.paperclipWorkspace.cwd`、`runtime.sessionParams.cwd` 均对应各自的本机目录，结果仍归属各自运行。

本轮没有发现需要修改生产代码的串线缺陷。服务器连接按公司与智能体组合隔离，并在接收帧时校验当前运行 ID；成员端路径重写也按任务上下文的项目 ID 读取映射。本轮仅补充可重复的回归覆盖。

## 验证结果

- `server`: `src/adapters/member-agent/protocol.test.ts`、`src/adapters/registry.test.ts`、`src/__tests__/adapter-registry.test.ts`：**98 passed**。
- `member-agent`: 全部测试：**14 files, 202 passed**。
- `member-agent`: `pnpm exec tsc --noEmit`：退出码 0。
- `server`: `pnpm exec tsc --noEmit`：退出码 0。
- 完整输出：`parallel-server-regression.log`、`parallel-member-suite.log`、`parallel-server-tsc.log`、`parallel-member-tsc.log`。

测试输出中出现 pnpm 对仓库旧 `package.json` 的配置字段警告；服务器协议测试还记录了一条测试夹具的 runtime connection tools 投递警告。两项都没有导致测试失败。真实服务器上的 S7 仍需负责人按阶段 3 `acceptance.md` 执行和读回；本地隔离测试不等于真实成员账号验收。

## 本机 3100 状态

阶段 3 原记录的启动前状态为 PID `36504`、`processStartedAt=2026-10-25T12:03:57.742Z`。本轮末只读检查时，`http://localhost:3100/api/health` 返回连接被拒绝，3100 没有监听进程，因此无法比较 `processStartedAt`。本轮没有启动、停止或重启该服务；检查结果见 `parallel-health-after.json`。
