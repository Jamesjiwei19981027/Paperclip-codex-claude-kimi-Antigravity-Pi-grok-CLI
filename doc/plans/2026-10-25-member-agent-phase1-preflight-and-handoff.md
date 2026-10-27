# 成员智能体阶段 1：基线、源码备份与待裁定事项

日期：2026-10-25（Asia/Shanghai）。

状态：**阶段 1 未实现。** 已完成改动前基线检查和当前运行代码的备份；按负责人最新要求，保留三个问题交给 Claude 决定，暂停产品代码修改。本文不是九项验收通过报告。

## 当前运行代码已经备份

备份目录：`E:\AI_Data\backups\paperclip\2026-10-25-before-member-agent-phase1`。

- `source/`：当前工作区文件快照，包含未提交、未跟踪的源码和已有构建文件；复制 14,716 个文件，共 613,833,409 字节，逐文件 SHA-256 校验成功。目录中也保留了本机既有运行日志，日志内容未输出到本报告。
- `source-manifest.json`：文件路径、长度和 SHA-256 清单。
- `repository.bundle`：已有 Git 引用与历史，`git bundle verify` 通过。
- `working-tree.patch`、`staged.patch`、`git-refs.txt`：已有工作区改动、暂存区及引用信息。
- `backup-receipt.json`、`git-bundle-verify.txt`：备份回执与历史包校验输出。
- 排除了依赖目录、Git 原始目录和常见构建缓存；Git 历史由 bundle 单独保存。排除路径完整记录在 `excluded-paths.txt`。这是一份代码备份，不是生产数据库备份；没有对业务数据库执行复制、迁移或恢复。

备份时 HEAD：`e0a2f6025d63f6e1d2bf42717a5d4bd430496338`。备份前后 HEAD 和 Git 状态一致。

已确认 `127.0.0.1:3100` 的监听进程 PID 为 **31636**，使用 `D:\paperclip` 的 tsx / `src/index.ts` 启动路径；备份前后仍为相同 PID，健康接口均返回 `status: ok`。本次没有停止、重启或部署服务，也没有派发或取消正在运行的业务任务。

## 改动前测试与失败清单

运行时间：2026-10-25 15:32:24 开始，160.10 秒；本次没有修改产品代码。

工作目录：`D:\paperclip\server`。

```powershell
node ../node_modules/vitest/vitest.mjs run --config vitest.config.ts --reporter=verbose --cache=false src/__tests__/live-events-ws.test.ts src/adapters/registry.test.ts src/__tests__/adapter-registry.test.ts src/__tests__/agent-auth-jwt.test.ts src/__tests__/heartbeat-runtime-mcp-servers.test.ts src/__tests__/heartbeat-direct-adapter-native-isolation.test.ts src/services/heartbeat/run-lifecycle.test.ts src/services/heartbeat/recovery.test.ts
```

完整 stdout/stderr：[baseline-tests.log](2026-10-25-member-agent-phase1-evidence/baseline-tests.log)。没有删除告警或数据库 NOTICE。

结果：**8 个测试文件全部通过，129 项全部通过，exit 0；本次选定相关测试的改动前失败清单为空。**

- `server/src/__tests__/live-events-ws.test.ts`：8 项通过。
- `server/src/adapters/registry.test.ts`：35 项通过。
- `server/src/__tests__/adapter-registry.test.ts`：22 项通过。
- `server/src/__tests__/agent-auth-jwt.test.ts`：17 项通过。
- `server/src/__tests__/heartbeat-runtime-mcp-servers.test.ts`：12 项通过。
- `server/src/__tests__/heartbeat-direct-adapter-native-isolation.test.ts`：4 项通过。
- `server/src/services/heartbeat/run-lifecycle.test.ts`：17 项通过。
- `server/src/services/heartbeat/recovery.test.ts`：14 项通过。

这八个文件是本阶段相关基线，不是全仓测试。未据此宣称先前其他测试中的 35 项失败已经解决。

## 改动前 typecheck 失败清单

### 首次：当前默认脚本 shell

工作目录：`D:\paperclip`，命令：

```powershell
pnpm -r typecheck
```

完整输出：[baseline-typecheck.log](2026-10-25-member-agent-phase1-evidence/baseline-typecheck.log)。结果：**exit 1**。

原始失败摘要：

```text
packages/plugins/sdk typecheck: The syntax of the command is incorrect.
packages/plugins/sdk typecheck: D:\paperclip\packages\shared:
packages/plugins/sdk typecheck:  ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @paperclipai/shared@0.3.1 build: `tsc && mkdir -p dist/cliplab && cp src/cliplab/LICENSE src/cliplab/PROVENANCE.md dist/cliplab/`
packages/plugins/sdk typecheck: Exit status 1
packages/plugins/sdk typecheck: Failed
D:\paperclip\packages\plugins\sdk:
 ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @paperclipai/plugin-sdk@1.0.0 typecheck: `pnpm --filter @paperclipai/shared build && tsc --noEmit`
Exit status 1
EXIT_CODE=1
```

失败发生在既有脚本的 Windows shell 兼容性，未改源码进行修复。

### 重试：仅为此次命令使用已安装的 Git Bash

没有修改仓库配置或全局 pnpm 设置；只给重试进程设置脚本 shell：

```powershell
$env:npm_config_script_shell='D:\Program Files\Git\bin\bash.exe'
pnpm -r typecheck
```

完整输出：[baseline-typecheck-git-bash.log](2026-10-25-member-agent-phase1-evidence/baseline-typecheck-git-bash.log)。结果：**exit 1**。

原始失败摘要：

```text
server typecheck: Error [ERR_UNSUPPORTED_ESM_URL_SCHEME]: Only URLs with a scheme in: file, data, and node are supported by the default ESM loader. On Windows, absolute paths must be valid file:// URLs. Received protocol 'd:'
server typecheck: Node.js v24.18.0
server typecheck: Failed
D:\paperclip\server:
 ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @paperclipai/server@0.3.1 typecheck: `pnpm run prepare:runner-vendor && pnpm --filter @paperclipai/plugin-sdk ensure-build-deps && tsc --noEmit`
Exit status 1
EXIT_CODE=1
```

触发路径：Runner 构建的 `check:runner-workflow-traceability`；`packages/paperclip-runner/scripts/check-runner-workflow-traceability.mjs:5` 使用原生 Windows 绝对路径做动态 import。本次没有修复该清单外文件。typecheck 中既有构建前置步骤会生成本地构建产物，不等于修改产品源码或重启 `3100` 服务。

## 留给 Claude 决定的三个问题

负责人最新指示是先备份，以下问题保留，暂未批准任何选项。请不要把问题里的推荐项视为已经同意。

### 1. 能否把“适配器名单”的现有测试一起更新？

人话：现在有个测试把“系统里应该有哪些 Agent 工具”写成了固定名单。加一个 `member_agent`，就必须把这份预期名单也加一项，否则功能正常也会被测试报错。

依据：`server/src/adapters/registry.test.ts:64` 定义固定 expectedStrategies；`:83`、`:86` 要求实际内置适配器列表与该 map 完全一致。本次基线该文件的 35 项全部通过。

需要裁定：是否把 `server/src/adapters/registry.test.ts` 加入允许改动清单，仅补 `member_agent → environment` 的预期值。现有 §5 清单没有这个文件；不允许通过跳过、删掉断言或隐藏适配器来绕过测试。

### 2. “固定版本号”和“代码交付目录”存在哪里？

人话：你已经决定要有两项设置——让成员安装哪个 Codex 版本，以及报告中提示把代码交到服务器哪个目录。但还没有决定这两个值放在哪个配置文件或哪个设置界面里。实现时不能凭空另选一种存法。

依据：规格负责人决定 4 / 8 要求 `memberAgent.codeSyncDir` 和 `memberAgent.pinnedCodexVersion`；现有 `packages/shared/src/validators/instance.ts:25` 的实例设置不含这两个字段，`:34` / `:39` 为 strict schema；`server/src/services/instance-settings.ts:201`、`:540` 按既有字段归一化并写入。`server/src/config.ts:61` 的启动配置接口也没有 memberAgent 字段。

需要裁定：本阶段只使用明确的默认值、把可配置存取留后续，还是本阶段实现可保存的设置；若选择后者，请明确存取位置并同步批准涉及的配置、类型及调用文件。不要擅自改成环境变量或给服务器新增未约定的配置文件。

### 3. 点“检查在线”时，检查的是哪位成员的 Agent？

人话：当前“测试环境”函数只知道哪个公司、哪类工具，没有拿到具体 Agent 的编号。一个公司可以有多位成员，不能看到有人在线就说正在检查的那位也在线。

依据：`packages/adapter-utils/src/types.ts:369` 的 AdapterEnvironmentTestContext 只有 companyId、adapterType、config 和环境信息；`server/src/routes/agents.ts:3296` 的普通适配器调用没有传 agentId。规格 §5 要求 testEnvironment 检查“该智能体”是否在线，§9 的允许配置字段也未包含让用户自行填 agentId 的方式。

需要裁定：批准给共享上下文增加可选 agentId 并在调用处传入，还是本阶段在缺少身份时明确返回 warn“无法确认该 Agent 在线”。相应文件不在当前清单内，不能自行扩大。

## 按规格 §14 回报

阶段：1，停留在改动前基线和备份，尚未实现服务器骨架。

改动文件：本报告与 `doc/plans/2026-10-25-member-agent-phase1-evidence/` 下的三个完整输出文件。另按负责人要求，在仓库外创建了上述代码备份及其工具/回执。产品源码未修改；此前已有未提交改动予以保留。

运行过的命令与完整输出：见本报告的基线命令、三份完整日志及备份目录中的 `git-bundle-verify.txt`、`backup-receipt.json`。

验收项逐条结论：

1. 无/错/已撤销 Key、非 member_agent 拒绝：**未执行**，尚未实现新连接服务。
2. 重复 Agent 连接拒绝：**未执行**，同上。
3. 离线派发立即失败：**未执行**，尚未实现新适配器。
4. 在线假代理的运行、两条日志、用量和结果：**未执行**，假代理和新适配器尚未编写。
5. 五秒不确认失败：**未执行**，尚未实现。
6. 四十五秒心跳超时失败：**未执行**，尚未实现。
7. 操作员取消送达 job.cancel：**未执行**，尚未实现。
8. 跨公司隔离：**未执行**，尚未实现。
9. 令牌不出现在运行日志和错误：**未执行新实现验收**，本次没有签发或记录新的业务令牌。

既有 live-events-ws：改动前 8 项通过。新增测试完整输出：**尚无，未编写或运行新增测试**。改动前/改动后失败对照：**未执行改动后测试；不能宣称九项验收通过或实施后新增失败为零。**

偏离本规格的地方：无擅自实现或扩大代码白名单；依照负责人“先备份，三个问题交给 Claude”的最新指示暂停。

遇到但未解决的问题：上述三个范围/规格问题；两个改动前 typecheck 阻碍。

下一阶段需要负责人确认的事项：由 Claude 对三个问题给出明确结论并更新允许改动范围，再继续阶段 1。当前不进入阶段 2。
