# 成员代理 CodeBuddy 0.3.0 验证报告

日期：2026-10-28。基准提交：`2284d913875b320850e51cc0087f9e87f9059323`。改动留在指定工作树，未提交、暂存、重置或部署；未向仓库依赖目录安装任何包，未改另一个任务的技能目录。

## 交付与设计落实

成员代理版本已升级为 0.3.0。新增 `executor="codebuddy"`、`codebuddyEntry`、`codebuddyHome`、可选 `codebuddyModel`，沿用 `runtimeDir`。CodeBuddy 固定为 2.169.0。默认 Codex 版仍使用原 ZIP 名称，不含 CodeBuddy 执行器、启动器、CLI 依赖及 Claude bundle。

`build-runtime.mjs` 将原有 Claude CLI `execute.ts` 打成 `server/dist/claude-local.mjs`，哈希纳入同一 runtime MANIFEST。没有修改 `packages/adapters/claude-local/`。CodeBuddy 执行器实际调用该 execute；没有另写提示词组装实现。

目录映射、上下文本地化、技能复制、REST 恢复指导、环境白名单、结果字段白名单、代理解析与日志打码已共用。原 `codex-support.ts` 保留重导出兼容面；既有 Codex 执行器测试断言未改。版本测试仅更新版本预期及将“未来最低版本”用例移到 0.4.0。

专属配置目录默认为 `%APPDATA%\paperclip-member-agent\codebuddy-home`。不会覆盖 USERPROFILE/HOME。真实路径检查拒绝个人 `.codebuddy` 本身、内部目录及目录联接别名；项目工作目录也不能位于个人 `.codebuddy`。共享登录凭据仅检查存在性，不读取、复制或打印内容。

启动器采用 npm 标准 `.cmd` 结构，适配器将其解包为 Node 和 TypeScript 启动器直接执行；PATH 前置成员代理自身 Node 所在目录，启动器再以 `process.execPath` 启动 CodeBuddy。多行提示词不经过 cmd.exe。系统提示词文件参数转为文本参数，超过 20000 字符则前置到 stdin 的 `<agent-instructions>` 中。

配置模型为空时，启动器移除 Claude 适配器默认补上的模型参数，使 CodeBuddy 使用登录主体的默认模型。显式模型只接受 CodeBuddy 名称，任何 `claude-*` 都不会传给 CodeBuddy。

终态 `result.is_error=true` 即使进程退出码为零，也转换为失败。未登录映射为 `member_agent_codebuddy_login_required` 并提示运行 `start.ps1 -Mode login`；模型不可用映射为 `member_agent_configuration_error` 并提示修改 `codebuddyModel`。其他失败保留 Claude CLI 分类。终态 result 的 session_id 优先于其后的重复 init。

看板按每行顶层 type 分流 Claude/CodeBuddy 与 Codex，新增三份脱敏真实 fixture，覆盖工具调用、工具结果、成功、认证失败及 result 后重复 init；原 Codex fixture 和断言保留。

## Claude CLI 复用审查

- 引擎：默认会选择 ACP，本执行器明确设置 `engine="cli"`，不启动 ACP、不进行 ACP 认证探测。
- 命令检查：本地执行会检查命令可解析性；生成的 npm 标准垫片及 PATH 中的当前 Node 已通过真实执行证明可用。
- 版本探测：Claude 的模型版本门槛只作用于特定 Claude 模型和 Claude 命令名；本执行器使用 codebuddy.cmd 与 CodeBuddy 模型，因此不触发该门槛。成员自检独立检查固定 CodeBuddy 版本。
- 能力探测：effort 帮助探测限于 sandbox 执行目标，本执行器使用 local 且不设置 effort，不触发。
- 登录：普通 CLI execute 不主动执行 Claude login；输出文字认证分类仍复用，并在成员执行器边界转成 CodeBuddy 中文错误。交互登录由独立 CodeBuddy 命令负责。
- 配置：`managedAiConnection=true`、local 目标及明确的 CLAUDE_CONFIG_DIR 避开 Claude 配置种子复制。CLAUDE_CONFIG_DIR 仅供复用层状态定位；CodeBuddy 使用专属 CODEBUDDY_CONFIG_DIR。
- 技能与缓存：运行时 Paperclip 技能复制到 CodeBuddy 专属目录；Claude 提示词缓存和 MCP 临时文件由进程级 PAPERCLIP_HOME 定向到该专属目录内，不触及个人 Claude 配置或主仓库状态。
- 启动参数：适配器的 print、verbose、stream-json、setting-sources、resume、add-dir 可用；唯一不兼容的系统提示词文件参数由启动器转换。CodeBuddy 支持的 strict MCP 参数保留，但当前 runtimeToolDelivery 为 environment，不提供原生 MCP 控制面。

## 权限、取消和时间限制

真实验收使用 `deepseek-v4.1-flash`，每次创建全新临时 CODEBUDDY_CONFIG_DIR，结束后删除；未更改成员登录环境。没有设置 CODEBUDDY_IS_SANDBOX，也没有使用 FullAccess。

`Remove-Item -LiteralPath '.\high-risk-victim' -Recurse -Force` 在独立临时目录中执行成功，9.494 秒完成。但固定版本的基础风险表没有把此拼写匹配为 HIGH，因此它不能独自作为 HIGH 证明。

补充探针使用 PowerShell `rm -r -Force -LiteralPath '.\high-risk-victim'`，命中该版本源码明确的 HIGH 正则；真实工具结果退出码为 0，临时目录确实删除，最终 DONE，`permission_denials=[]`，16.765 秒完成，没有挂起。详细依据和短源码摘录见 `risk-source-evidence.txt`，完整脱敏行见 `live-high-stdout.jsonl`。

该固定版本在 print 普通权限路径跳过危险命令交互询问；默认文本输入下，仍需交互审批而没有界面的动作会自动拒绝。`--output-format stream-json` 与可处理审批的 `--input-format stream-json` 不同，本执行器不设置后者。`-y` 优先于 `--permission-mode dontAsk`；单独 dontAsk 会收紧正常写工具权限，所以没有加入此参数。

保留任务最长运行时间和 15 分钟无输出看门狗。看门狗使用虚拟时间测试验证重置及超时结果，没有额外等待真实 15 分钟；真实进程终止路径由中途取消验收覆盖。CodeBuddy 子进程登记创建时间，终止前重新核对身份，避免历史 PID 复用误杀；JobRunner 原有进程树清理仍作为兜底。

## 真实本机端到端

运行命令：

```powershell
node doc/plans/2026-10-28-member-agent-codebuddy-evidence/live-executor.mts write
node doc/plans/2026-10-28-member-agent-codebuddy-evidence/live-executor.mts cancel
node doc/plans/2026-10-28-member-agent-codebuddy-evidence/live-executor.mts permission
node doc/plans/2026-10-28-member-agent-codebuddy-evidence/live-executor.mts high
```

最后一次写文件：hooks.log 收到 stdout 共 8 行，其中 1 行为代理提示、7 行为 CodeBuddy JSON；首个 hooks stdout 为 82 毫秒，首个 CodeBuddy JSON 为 3771 毫秒，执行器总耗时 10019 毫秒。PowerShell 确实写出 `proof.txt`，内容为 `CODEBUDDY_TOOL_OK`，最终回复 DONE。结果：exitCode=0、errorCode=null、sessionId=`01a182b1-fdb4-740f-b30d-03c92fb3a1d1`；usage 为 inputTokens=22727、outputTokens=159、cachedInputTokens=28416。

最后一次取消：hooks stdout 5 行，其中 CodeBuddy JSON 4 行，首个 JSON 3357 毫秒。15 秒计时器因调度在 15103 毫秒触发 abort，922 毫秒后结束，总耗时 16025 毫秒，低于要求的取消后 30 秒。结果 exitCode=1、errorCode=cancelled、sessionId=null、usageComplete=false；已观测 usage 为 inputTokens=47934、outputTokens=245、cachedInputTokens=2944。

取消前子孙进程清单（仅本次测试的进程，完整 PID/父 PID 见 `live-cancel.json`）：31856 node.exe、43836 pwsh.exe、2120 conhost.exe、19708 bash.exe、42328 conhost.exe、22436 bash.exe、50372 bash.exe。取消后这些进程及启动器均不存活，残留为 0。包含实际 PowerShell 等待中的工具调用。

验证过程中曾发现 onSpawn 回调返回 undefined 导致复用层调用 `.catch` 失败，已修为异步回调并新增回归测试。最后写文件与取消均在该修复以及进程身份保护之后重跑。

## 自动化验证

改前先运行 `node member-agent/scripts/build-runtime.mjs`，随后在 member-agent 目录执行：

```powershell
node ..\node_modules\vitest\vitest.mjs run --config vitest.config.ts --cache=false
```

真实基线：25 文件、419/419 通过，360.57 秒。改后同命令：32 文件、454/454 通过，467.86 秒。见 `baseline-summary.json`、`member-full-final.log`。

最终 10 个定向文件连续三轮，每轮 123/123 通过，分别 8.38、8.77、8.53 秒。命令为上面的 Vitest 命令后追加：

```text
test/codex-executor.test.ts test/codex-support.test.ts
test/codebuddy-executor.test.ts test/codebuddy-cli.test.ts
test/codebuddy-config.test.ts test/codebuddy-launcher.test.ts
test/codebuddy-connection.test.ts test/codebuddy-runtime.test.ts
test/cli.test.ts test/agent-version.test.ts
```

安装器新增测试最终包含 11 项，完整连续三轮均 11/11 通过，分别 111.29、86.49、79.70 秒；命令为 `pnpm exec vitest run --root member-agent --config vitest.config.ts --configLoader runner test/codebuddy-installer.test.ts`。实际输出归档为 `codebuddy-installer-round-1.log` 至 `codebuddy-installer-round-3.log`。它还与既有安装器、确认、局域网兼容测试组合跑过 102/102；Codex 原 build-installer 测试的 32 项断言未改。

UI 的既有与新增测试文件连续三轮均为 11/11 通过。原命令（ui 目录）：`pnpm exec vitest run src/adapters/member-agent/index.test.ts src/adapters/member-agent/codebuddy.test.ts --cache=false`。最后另用 runner 配置加载器复核 11/11；为兼容既有 vitest.config.ts 的 __dirname，预载 `globalThis.__dirname=process.cwd()`，避免修改项目配置。直接使用 runner 而不提供该兼容值曾启动失败，随后按此修正测试命令。

类型检查：member-agent 目录 `pnpm exec tsc --noEmit` 退出 0；根目录 `pnpm --filter @paperclipai/ui typecheck` 退出 0。`pnpm check:token-gates` 退出 0，扫描 1209 文件，四个 gate 全部 CLEAN。`git diff --check` 退出 0。

没有修改 server 或 Claude 适配器包，因此未运行其全量测试。未运行仓库全量 typecheck/build/test 或浏览器套件，本任务按照指定成员端、UI 和安装器范围验证。

## 安装包与等价自检

构建命令：

```powershell
node member-agent/scripts/build-installer.mjs --executor codebuddy --node-zip <已有官方NodeZIP>
```

复用指定缓存中的 Node ZIP，未重新下载 ZIP。Node ZIP SHA-256 为 `0ae68406b42d7725661da979b1403ec9926da205c6770827f33aac9d8f26e821`。CodeBuddy 仅在系统临时新目录安装，参数包含固定版本、ignore-scripts、no-audit、no-fund；安装后核对 package-lock 的根包 integrity 等于批准的 sha512。保留完整运行依赖，平台可选依赖由 npm 自动按 Windows 过滤，没有额外手工裁剪官方包内资源。

产物：`member-agent/dist-installer/PaperclipMemberAgent-0.3.0-codebuddy.zip`。

- 大小：128845050 字节，约 122.88 MiB。
- SHA-256：`ee8f86da8783711f2eda1e5891542fd657bba7fd80c58714104dd84d2c6a5ea4`。
- ZIP 文件 10462 个；MANIFEST 记录 10461 个；CodeBuddy 子树 10394 个。所有路径使用 `/`，无 Codex 二进制。
- 独立复核全部文件大小及 SHA-256 均匹配，且包内执行器和安装脚本与最终工作树一致，源码差异 0。

临时解压后使用包内 Node 调用与 check 相同的 `inspectCodeBuddyInstallation`，输出为 version=2.169.0、loggedIn=true、packageIssues=[]、runtimeIssues=[]、ok=true。只检查登录存在性；`--help` 支持 resume 和 allowedTools。见 `installer-verification.json`、`final-zip-verification.json`。

采用用户允许的“等价自检”：没有执行系统实际安装，没有访问平台，也没有运行包含平台连接步骤的完整 start.ps1 check。新设备仍须交互登录后完成该连接自检。

## 设计偏离与限制

未偏离复用 claude_local 的核心设计，也未修改服务器必填协议或 minimumAgentVersion。服务端 hello 校验按必填字段验证并允许多余字段，故加入可选 executor/executorVersion；CodeBuddy 的必填 codexVersion 仍为 none，Codex pin 比较仅在 Codex 执行器生效。

两个实现补充：CodeBuddy 安装目录/版本指针使用 `0.3.0-codebuddy`，代理报告版本仍为 0.3.0，避免同版本 Codex 与 CodeBuddy 覆盖而失去回滚；ZIP 实际源文件加 Windows 扩展路径前缀，解决深工作树路径超过 260 字符的真实压缩失败，ZIP 内路径仍规范。二者均有测试。

权限结论限定于固定 2.169.0 和本机真实探针；没有通过增加沙箱全放行标记来改变权限。没有现场走一遍新的交互登录流程，以免修改成员现有共享登录；仅确认其存在并通过真实模型执行证明可用。取消中的用量是未完成检查点，不是完整终态账单。

证据和报告保留在要求的工作树目录。当前会话没有绑定的 Paperclip 工单信息、上传凭据或 register_deliverable 工具，无法按工单附件流程上传；因此没有声称已上传或更改工单状态。补丁不随仓库提交（补丁及导出脚本已移出仓库工作树）。

## 审核修复（第二轮）

1. **三处修复的文件位置**：
   - 本地无输出超时错误码改为 `member_agent_timeout`：`member-agent/src/executors/codebuddy.ts`（第 150 行），对应测试更新位于 `member-agent/test/codebuddy-executor.test.ts`（第 77、95 行）。
   - Codex 版安装器恢复“现在登录 Codex 吗？”并为 CodeBuddy 版增加“现在登录 CodeBuddy 吗？”：`member-agent/installer/install.ps1`（第 244、249 行），对应新增测试位于 `member-agent/test/installer-login.test.ts`（第 1–43 行）。
   - 未登录时 `run` 照常上线只告警（`check` 仍失败）：`member-agent/src/main.ts`（第 91–94 行），对应新增测试位于 `member-agent/test/codebuddy-startup.test.ts`（第 38–57 行）。

2. **`review-*.log` 测试计数（尾部如实摘录）**：
   - `review-red.log`：`Test Files  3 failed (3)`，`Tests  17 failed | 12 passed (29)`（Duration 9.73s）
   - `review-green.log`：`Test Files  3 passed (3)`，`Tests  29 passed (29)`（Duration 9.57s）
   - `review-target-round-1.log`：`Test Files  3 passed (3)`，`Tests  29 passed (29)`（Duration 9.25s）
   - `review-target-round-2.log`：`Test Files  3 passed (3)`，`Tests  29 passed (29)`（Duration 9.92s）
   - `review-target-round-3.log`：`Test Files  3 passed (3)`，`Tests  29 passed (29)`（Duration 9.82s）
   - `review-member-full.log`：未找到（日志仅记录启动行 `RUN  v5.0.3 D:/paperclip/.claude/worktrees/codebuddy-executor-6332a5/member-agent`，无尾部测试计数）
   - `review-member-typecheck.log`：未找到（类型检查日志，仅含 pnpm 配置告警，无测试计数）

3. **补丁文件说明**：
   - 补丁不再放在仓库内：`codebuddy.patch`、`patch-metadata.json`、`export-patch.mjs` 已从 `doc/plans/2026-10-28-member-agent-codebuddy-evidence/` 移出至仓库外的临时私有目录（`scratchpad/evidence-private/`），补丁不随仓库提交。

4. **修复后重新打包产物**：
   - `member-agent/dist-installer/PaperclipMemberAgent-0.3.0-codebuddy.zip`：128845296 字节，SHA-256 `514cf4349a2da216f3a0493f6bc384d2bbb3835f6a3684137de05151fe41f56d`
   - `member-agent/dist-installer/PaperclipMemberAgent-0.3.0.zip`：173267692 字节，SHA-256 `3346e0f4145b74f3921e26edcb35c67cf6e8e9a458e6490b31d35e9b1d3288a1`

## 最终安装包（负责人复核，2026-10-28 22:35）

安装说明修正（解压到短路径提示、安装时登录询问的现状描述）后重新构建。上文各处记录的较早哈希均为历史构建，已被以下最终版本取代：

- `PaperclipMemberAgent-0.3.0-codebuddy.zip`：128845468 字节，SHA-256 `f0db41e126dde5c4e98c7d662d8f394e7171f964570011576a5cb695adf743ff`
- `PaperclipMemberAgent-0.3.0.zip`（Codex 版）：173267864 字节，SHA-256 `41572aaa8dc12aef7a5377df73848a1cdcc9ef0ba2ab781743d04b60e9c0d83d`

负责人复核结果：成员端全量 34 个文件 475/475 通过；成员端与 ui 类型检查通过；ui 成员适配器测试 11/11；服务端成员适配器测试 55/55；token gates 全部通过；安装器相关测试 85/85；CodeBuddy 版安装包经 Windows PowerShell 5.1 Expand-Archive 解压到短路径（10462 个文件）后，包内 Node 自检通过（版本 2.169.0、共享登录存在、包清单与运行时完整，约 2.4 秒）。
