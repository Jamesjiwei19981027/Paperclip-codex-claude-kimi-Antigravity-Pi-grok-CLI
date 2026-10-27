# 成员代理阶段 3 细化规格：接入 Codex

日期：2026-10-25  
前置：阶段 1（服务器端）、阶段 2（成员代理骨架，真实服务器验收 A1–A8 全部通过）已完成。阶段 2 补丁已应用到 `D:\paperclip\member-agent\`。  
上位文档：[总规格](2026-10-25-member-agent-implementation-spec.md)、[阶段 2 规格](2026-10-25-member-agent-phase2-spec.md)、[阶段 0 核对结果](2026-10-26-member-agent-phase0-findings.md)。**总规格第 2 节硬性规则、第 14 节回报格式、"阶段 0 之后的负责人决定"全部继续有效；冲突时以总规格为准并回报。**

## 0. 本阶段的依据：已做过的实验（事实，不是假设）

2026-10-25 在 `D:\paperclip` 之外做了"打包路线"实验，结论如下，本规格据此设计：

1. 用 esbuild 把 `@paperclipai/adapter-codex-local/server` 打成**单个 3.1 MB 文件**，245 毫秒，0 错误 0 警告；
2. 放在仓库外的目录，配上真实 **Codex 0.160.0**（`codex.exe`）和本地假模型服务，调用 `execute()`（命令行引擎）：**退出码 0**，日志、元数据、进程创建、两次用量回报都收到；
3. 在**另一台没有仓库的电脑**上同样跑通；
4. 打包后必须带的附属文件：`codex-auth-merge-decision.cjs`、`codex-auth-merge-extract.sh`（模块加载时就读取，缺失会直接报 `ENOENT`），放在包旁边；技能目录要放在包的上两级（`../../skills`，适配器按相对位置找）；
5. **技能注入会在没有符号链接权限的 Windows 电脑上失败**：适配器用 `fs.symlink`（`execute.ts:550`）把技能链进 `CODEX_HOME/skills`，在没开"开发者模式"、非管理员的电脑上报 `EPERM`，**运行仍然"成功"但智能体看不到 Paperclip 技能**。绕过办法已在那台电脑上验证有效：**调用适配器之前，代理自己把技能目录复制成真实目录**放进 `CODEX_HOME/skills/<名称>`，适配器发现已有真实目录会跳过链接，不报错；
6. 没有验证的：真实 Codex 账号、会话续接、取消与进程树、与服务器的完整往返。

## 1. 范围

### 本阶段要做

1. **打包脚本**：把 Codex 适配器打成单文件，产出标准目录布局，带版本清单（第 3 节）；
2. **Codex 执行器**：成员代理的第二个执行器 `codex`，在执行线程里加载打包文件，构造适配器上下文，调用 `execute()`，把回调映射成协议帧（第 4–7 节）；
3. **执行器接口扩展**：增加元数据、用量、子进程登记的钩子；
4. **进程树接线**：登记 Codex 子进程，取消、超时、断线时统一终止进程树（阶段 2 遗留的已知风险，第 8 节）；
5. **技能物化**：每次运行前把技能复制成真实目录（第 5.5 节）；
6. **`login` 命令**：用固定版本 Codex 做设备登录，凭据只写入成员专属 `CODEX_HOME`（第 9 节）；
7. **版本检查**：`hello.codexVersion` 改为真实版本，并按服务器下发的固定版本比对（第 10 节）；
8. **路径替换**：把任务里所有服务器路径换成成员本机路径（第 6 节）。

### 本阶段不做（做了算偏离）

- 安装包、开机自启、自动升级、自动下载 Codex（阶段 6）；
- 服务器下发技能内容（本阶段技能随代理打包，见第 12 节未决问题）；
- 任何 MCP 工具（`runtimeToolDelivery` 为 `environment`，见总规格决定 6）；
- 本机工作树的自动创建、合并、回收（总规格决定 5：每个智能体同一时间一个任务，项目目录由成员预先配置）；
- Claude Code、CodeBuddy 等其他工具的执行器；
- 修改服务器端代码、协议、数据库；修改 `D:\paperclip`；
- 修改 `codex-local` 适配器或 `adapter-utils` 的任何源码（只打包它们，不改它们）。

## 2. 工作方式

- **隔离副本**：只在 `E:\workspace\paperclip-member-agent-dev` 里开发，不得编辑 `D:\paperclip`，不得向其应用补丁。副本已经含阶段 2 的全部代码和小修；开工前先确认它与 `D:\paperclip\member-agent\` 一致（逐文件比对，记录结果）；
- **构建输出一律使用绝对路径并断言**：2026-10-25 曾有一次 esbuild 的 `outfile` 相对路径被解析到 `D:\paperclip\out\`，误写进了仓库。**打包脚本必须把 `outfile`、`absWorkingDir`、拷贝目标全部用 `path.resolve` 变成绝对路径，并在写入前断言目标位于 `member-agent/runtime/` 之内，否则抛错**。对应要有测试；
- 不得通过 `D:\paperclip\node_modules` 的联接安装依赖。构建只**读取**那里的 esbuild（可执行，不写入）；
- 成员代理运行时的第三方依赖仍然只有 `ws`；esbuild 是**仅构建期**工具，不得进入 `member-agent/package.json` 的 `dependencies`。构建脚本通过 `createRequire` 从副本的 `node_modules/.pnpm/esbuild@*` 解析，找不到则给出中文说明并失败；
- 交付：补丁放到 `D:\paperclip\doc\plans\2026-10-25-member-agent-phase3-evidence\phase3.patch`，只含 `member-agent/` 下的新增与改动；`git apply --check` 在干净临时副本上验证；不得应用。

## 3. 打包脚本与运行时目录

### 3.1 命令

`node member-agent/scripts/build-runtime.mjs [--out <目录>]`，默认输出到 `member-agent/runtime/`（已被 `.gitignore` 忽略，**不得提交构建产物**）。

### 3.2 产出布局（适配器按相对位置找文件，布局不能改）

```text
runtime/
  server/dist/
    codex-local.mjs                         # esbuild 单文件，ESM，platform node，target node24
    codex-auth-merge-decision.cjs           # 从 packages/adapters/codex-local/src/server/ 原样复制
    codex-auth-merge-extract.sh             # 同上
  skills/                                   # 位于 server/dist 的上两级
    paperclip/                              # 从仓库 skills/paperclip 原样复制
  MANIFEST.json
```

### 3.3 MANIFEST.json

字段：`builtAt`（ISO 时间）、`repoCommit`（读 git，读不到写 `unknown`）、`adapterPackageVersion`（读 `packages/adapters/codex-local/package.json`）、`bundleSha256`、`assets`（每个附属文件的 sha256）、`skills`（每个技能目录的哈希）、`esbuildVersion`、`nodeTarget`。代理启动时读取并在 `check` 命令里打印，便于排查"成员的包和服务器版本是否匹配"。

### 3.4 打包选项

- `bundle: true`、`platform: "node"`、`format: "esm"`、`target: "node24"`；
- `banner` 注入 `createRequire`（实验里已验证需要，否则打入的 CommonJS 依赖会报 `require is not defined`）；
- **不得**把 `ws` 之外的运行时依赖设为 external 后留空；打包结果必须能在**没有任何 `node_modules` 的目录**里被 `import`；
- 开启 `metafile`，把按包统计的体积写进构建日志，便于以后发现体积异常增长；
- 构建失败、产生警告时脚本退出码非 0，并把警告原样打印（实验当时是 0 警告，作为基线；出现新警告必须说明）。

### 3.5 测试（构建脚本）

1. 构建后产出布局与 3.2 完全一致，MANIFEST 字段齐全；
2. **把产出复制到系统临时目录**（路径上没有任何 `node_modules`、也不在仓库内）后能 `import`，且 `typeof execute === "function"`；
3. 删除任一附属文件后再 `import`，应该失败（证明测试确实依赖它们）；
4. `outfile` 解析到 `member-agent/runtime/` 之外时脚本抛错（用故意传入的恶意 `--out` 测试：相对路径、`..` 越界、指向仓库根目录）；
5. 构建不修改仓库内任何被 Git 跟踪的文件，也不在仓库里创建 `out/` 之类目录（构建前后对比 `git status --porcelain`）。

## 4. 执行器接口扩展

阶段 2 的 `ExecutorHooks` 只有 `log`、`event`、`signal`、`job`、`serverUrl`。本阶段扩展为（**保持向后兼容，`echo` 执行器不改**）：

```ts
export interface ExecutorHooks {
  log(stream: "stdout" | "stderr", text: string): void;
  event(event: Record<string, unknown>): void;
  meta(meta: Record<string, unknown>): void;          // → job.meta，经 validateMeta 严格校验
  usage(checkpoint: Record<string, unknown>): void;   // → job.usage，经 validateUsage 严格校验
  childSpawned(pid: number): void;                    // 登记本机子进程，供取消/超时/断线时终止进程树
  signal: AbortSignal;
  readonly job: JobStart;
  readonly serverUrl: string;
}
```

- `meta`、`usage` 在执行线程里通过消息发给 `job-runner`，由它构造帧、做白名单校验、经脱敏后发送；
- 校验失败的 `meta`/`usage`：**丢弃并写一条本机警告日志，不得让整个任务失败**（元数据和用量的瑕疵不应毁掉任务），但**必须有计数**，在 `job.result` 的 `summary` 之外的本机日志里记录丢弃条数；
- `childSpawned` 只接受正整数；`job-runner` 内部保存当前任务的子进程号集合（上限 64，超出忽略并告警）。

## 5. Codex 执行器

文件：`member-agent/src/executors/codex.ts`（在执行线程里运行）。

### 5.1 加载

- 配置 `runtimeDir` 指向第 3 节的产出目录；用 `import(pathToFileURL(<runtimeDir>/server/dist/codex-local.mjs>))` 加载；
- 加载前校验：附属文件、`skills/paperclip` 存在；缺失给出明确中文错误和修复办法（"请重新运行 build-runtime"），**错误码 `member_agent_runtime_missing`**，不要把原始 `ENOENT` 堆栈发给服务器；
- 加载一次后缓存，同一执行线程内不重复加载（每个任务一个执行线程，所以实际每任务加载一次，可接受；不要为此引入常驻线程）。

### 5.2 在调用 `execute()` 之前必须做的环境处理

1. **清除长期密钥**：执行线程的 `process.env` 里**删除 `PAPERCLIP_AGENT_KEY`**。Codex 子进程默认继承环境，不删就等于把成员智能体的长期 Key 交给了 AI。只保留本次运行令牌（适配器会把 `ctx.authToken` 写进子进程的 `PAPERCLIP_API_KEY`）；
2. **设置 `PAPERCLIP_API_URL`**：必须设在**执行线程自己的 `process.env`** 上，值为代理连接用的 `serverUrl`。实验证明只写进 `config.env` 无效，子进程拿到的仍是 `http://localhost:3100`；
3. 清除可能干扰的继承变量：`OPENAI_*`、`ANTHROPIC_*`、`CODEX_*`（除下面显式设置的 `CODEX_HOME`）、其余 `PAPERCLIP_*`（除上面设置的 `PAPERCLIP_API_URL`）。**白名单优于黑名单**：不确定的一律不传；
4. 设置 `CODEX_HOME` 为配置里的成员专属目录，**不得**指向 `%USERPROFILE%\.codex`；
5. 临时目录、`PATH`、`SystemRoot` 等系统必需变量保留。

### 5.3 构造 `AdapterExecutionContext`

| 字段 | 取值 |
|---|---|
| `runId` | `job.jobId` |
| `agent` | `{ id: job.agent.id, companyId: job.companyId, name: job.agent.name, adapterType: "codex_local", adapterConfig: {} }` |
| `runtime` | 来自 `job.runtime`，其中 `sessionParams` 经第 6 节路径替换 |
| `config` | 见下表 |
| `context` | 来自 `job.context`（服务器已按白名单发送），经第 6 节路径替换 |
| `executionTarget` | `{ kind: "local" }` |
| `authToken` | `job.authToken` |
| `getFreshSessionHandoff` | `async () => (job.handoffMarkdown.trim() ? job.handoffMarkdown : null)` |
| `onLog` | → `hooks.log` |
| `onMeta` | → `hooks.meta` |
| `onEvent` | → `hooks.event` |
| `onUsage` | → `hooks.usage` |
| `onSpawn` | → `hooks.childSpawned(meta.pid)` |
| `onRuntimeProgress` | 忽略（不发协议帧） |
| `signal` | `hooks.signal` |
| 其余 | **不传**：`agentIdentity`（含服务器私钥）、`runtimeMcp`、`startupTraceContext`、`stopRemoteStartup`、`onProviderStopped`、`onDispatch`、`onCancellationReady`、`executionTransport`、`runtimeCommandSpec` |

`config`：

| 字段 | 取值 |
|---|---|
| `engine` | `"cli"` 固定（命令行引擎；默认的 ACP 引擎会经过 `.cmd` 垫片，Windows 上不可靠） |
| `command` | 配置里的 `codexExecutable`，必须是**绝对路径的 `.exe`**，不得是 `.cmd`/`.bat` |
| `cwd` | 第 6 节解析出的本机目录 |
| `timeoutSec` | `job.config.maxRunSec`（缺省 3600） |
| `graceSec` | 20 |
| `env` | 只放 `CODEX_HOME`；以及 5.4 的工具环境变量。**不要**放 `PAPERCLIP_API_URL` |
| `model` | **不设置**（总规格决定 2：服务器不下发模型，用成员本机 Codex 的默认设置） |
| `extraArgs` | 空 |
| `managedAiConnection` | **实验里设成了 `true` 以绕过本机认证检查，那只是为了让假服务能跑**。真实运行时的正确取值由实现者读 `execute.ts` 中该字段的全部用法后判断，**默认不设置**；若发现必须设置才能运行，停下回报，不得照抄实验值 |

### 5.4 运行工具环境变量（连接搜索、连接申请）

`job.runtimeTools` 不为空时，代理要像 `process` 适配器那样把它们交给 Codex（总规格决定 6 的第一条硬要求）：

- 读 `packages/adapter-utils/src/server-utils.ts:29` 的 `buildRuntimeToolsEnv`，用**相同的变量名**把端点、令牌、到期时间设入 Codex 子进程环境（经 `config.env`）；
- **端点地址里的服务器内部主机名要替换**为代理连接用的 `serverUrl` 的来源（和 `PAPERCLIP_API_URL` 同一规则），否则成员机访问不到；
- 工具令牌 1 小时过期（总规格已接受，不做续期）。

### 5.5 技能物化（硬性要求，实验已证明必须）

每次调用 `execute()` 之前：

1. 确定目标：`<codexHome>/skills/<技能名>`，技能来源是 `runtimeDir/skills/<技能名>`；
2. 目标**不存在**：复制整个目录（`fs.cp` 递归）；
3. 目标**已存在且是真实目录**：比较内容哈希（沿用适配器里 `hashSkillDirectory` 的思路：路径、模式、文件内容），不同则**原子替换**（先复制到同级临时目录，再改名；不要先删后写）；相同则跳过；
4. 目标**已存在但是符号链接**：删除链接，改为真实目录；
5. 复制失败：本次任务**必须失败**，错误码 `member_agent_skill_install_failed`，**不得带着"没有技能"继续运行**（这是实验里最隐蔽的失败：运行成功、智能体什么都不会做）；
6. 不要碰 `.system` 等 Codex 自己管理的目录；
7. 测试：在**没有符号链接权限**的环境里运行（见第 11.1 节第 9 项）。

### 5.6 结果映射

`execute()` 返回的结果经 `validateResult`（阶段 2 已有白名单）再返回。要核对的字段（`adapter-utils/src/types.ts:102`）：`exitCode`、`signal`、`timedOut`、`errorCode`、`errorMessage`、`errorFamily`、`retryNotBefore`、`summary`、`resultJson`、`sessionId`、`sessionDisplayId`、`sessionParams`、`clearSession`、`usage` 及计费字段。**白名单之外的字段丢弃并记一条本机警告，不得原样转发。**

- `sessionParams` 里的本机路径：见第 6 节"回传"；
- 若适配器返回 `exitCode !== 0` 且 `errorCode` 为空，补 `errorCode: "member_agent_codex_failed"`；
- 若适配器抛异常：捕获，转成 `exitCode: 1`、`errorCode: "member_agent_executor_error"`、简短中文 `errorMessage`（经脱敏，不含堆栈）。

## 6. 路径替换（阶段 0 Q5 的实测结论，必须全部做到）

**为什么重要：** Codex 适配器优先用 `context.paperclipWorkspace.cwd`，其次才是 `config.cwd`。只改 `config.cwd` 会继续在服务器路径下运行，甚至在成员电脑上新建同名目录。

### 6.1 解析本机目录

1. 项目编号：`context.paperclipWorkspace.projectId`，其次 `context.projectId`；
2. 查配置 `projectDirs[项目编号]`；没有则用 `defaultCwd`（非空）；都没有 → **失败**，`member_agent_cwd_unresolved`，错误信息写明项目编号和怎么配置；**绝不用代理自己的工作目录**；
3. 目录必须**已存在且是目录**；不存在 → 失败 `member_agent_cwd_missing`。**不得让适配器自动创建**（适配器会在目录缺失时自动建目录，要在调用前拦住）；
4. 目录不得位于代理自己的配置目录、`CODEX_HOME`、`runtimeDir` 之内（防止智能体改写代理自身）；
5. 规范化：`path.resolve`，拒绝含 `..` 的未规范路径，拒绝 UNC 路径（本期）。

### 6.2 重写上下文

对传给适配器的 `context` 副本：

- `paperclipWorkspace.cwd` → 本机目录；
- `paperclipWorkspace.worktreePath` → 删除；
- `paperclipWorkspace.agentHome` → 本机的代理专属目录 `%APPDATA%\paperclip-member-agent\agents\<agentId>\home`（不存在则创建）；
- `paperclipWorkspace.source` 若为 `agent_home` 之类依赖服务器目录的取值 → 保持字符串不变，但保证 `cwd` 已是本机目录；
- `paperclipWorkspaces`（复数）→ **整体删除**（本期只支持单项目单目录）；
- 其余字段（`repoUrl`、`repoRef`、`branchName`、`workspaceId`、`projectId`）原样保留，它们是标识不是路径；
- 上下文里的 Markdown 文本（`paperclipTaskMarkdown` 等）可能出现服务器路径，**不尝试改写**，但在本机日志里记录"任务文本中检测到疑似服务器路径"的次数。

### 6.3 会话参数

- `runtime.sessionParams` 里凡是路径字段（至少 `cwd`，以及实际观察到的其他路径字段）→ 本机路径；
- 实际有哪些字段，用阶段 0 实验里 `execute()` 的返回值核对，**不要凭猜测**；
- 回传：结果里的 `sessionParams` 保持本机路径不动（会话数据本来就在本机）。服务器是否会因为路径与自己的工作区不同而判定会话不兼容并重置，**是未验证项**，由第 11.3 节 S6 验证，结果如实记录，不要预设答案。

## 7. 事件、日志与用量

- 适配器的 `onLog` 内容（Codex 的 JSON 行输出）原样转为 `job.log`，仍走阶段 2 的脱敏和 UTF-8 分块；
- `onEvent` → `job.event`，`onMeta` → `job.meta`，`onUsage` → `job.usage`，全部经阶段 2 的严格校验；
- **用量不得只传 token 数**：`job.usage` 要带 `complete`、`attemptId`、`usageBasis`、provider/biller/billingType 等适配器给出的字段（总规格第 6 节）；
- 脱敏对象在原有三项之外，**加入本机的 Codex 登录凭据路径之外的敏感内容不会出现在输出里**这一点无法穷举验证，所以另有一条硬规则：**不得读取、转发或记录 `CODEX_HOME/auth.json` 的内容**；日志里只能出现该文件的存在与否。

## 8. 取消、超时与进程树（阶段 2 遗留风险，本阶段必须解决）

阶段 2 的 `process-tree.ts` 已实现并单独测试，**但没有任何代码调用它**；执行线程被 `terminate()` 时，线程里启动的子进程**不会**随之结束。本阶段接线：

1. `job-runner` 保存当前任务通过 `childSpawned` 登记的进程号；
2. **任何结束路径**都要终止进程树：
   - 正常结束：任务结果已返回后，仍存活的登记进程也要终止（防止 Codex 遗留的后台进程）；
   - 取消（`job.cancel`）：先发 `cancel` 给执行线程，等 `graceSec`；超时仍有存活进程则对每个登记进程调用 `terminateProcessTree`；
   - 本地超时（`maxRunSec`）：同上；
   - 连接断开（阶段 2 的 `disconnect()`）：同上；
   - Ctrl+C / `shutdown()` / `force()`：同上；`force()` 路径也不得遗漏；
3. 终止之后**确认进程确实不存在**；`taskkill` 失败时，结果要体现失败（`errorMessage` 追加"本机进程可能未完全结束，请手动检查进程 <号>"），**不得假装成功**；
4. 总处理时间必须小于服务器等待时间 `graceSec + 10` 秒，否则服务器会判"未确认本机进程已停止"；
5. 测试（Windows）：用测试专用的假 Codex（一个会启动孙进程并长期休眠的程序，作为 `command`），验证上述每一条路径结束后**孙进程也不在进程列表里**。假 Codex 必须是真实的 `.exe` 或由 `node.exe` 启动的脚本，不得是 `.cmd`。

## 9. `login` 命令

- `node member-agent/src/main.ts login [--config <文件>]`：用配置里的 `codexExecutable`，环境变量 `CODEX_HOME` 设为配置的 `codexHome`，**继承终端的输入输出**，执行 Codex 自带的设备登录流程（浏览器打开、输入验证码）；参考 `packages/adapters/codex-local/src/server/device-login-runner.ts`，但**不要引入该文件的复杂度**，本阶段直接让 Codex 自己的命令行完成登录即可；
- 登录成功后检查 `<codexHome>/auth.json` **存在**（只检查存在，不读内容），打印中文提示；
- 不要把登录过程的输出写进日志文件（可能含验证码或链接）；
- `check` 命令增加检查项：`codexExecutable` 存在且可执行、版本号、`codexHome` 是否已登录（存在 `auth.json`）、`runtimeDir` 是否完整。**每项独立打印通过或失败**，不要遇到第一个失败就停。

## 10. 版本

- `hello.codexVersion`：运行 `codexExecutable --version`（经 `execFile`，不经 shell），解析 `codex-cli X.Y.Z` 中的 `X.Y.Z`；失败则报配置错误，不得发 `"none"`；
- 与服务器 `hello.ack.pinnedCodexVersion` 比对：
  - 相同：正常；
  - 不同但都在 `>=0.149.0 <0.161.0` 内且是稳定版：**打印警告**，继续运行；
  - 超出窗口、预发布版、解析不出：**拒绝接受任务**，回 `job.result`，`errorCode: "member_agent_codex_version_unsupported"`，中文说明当前版本和需要的版本；代理继续保持连接（以便服务器看到明确原因，而不是掉线）；
- 本阶段**不下载、不安装、不替换** Codex（阶段 6）。

## 11. 验收

### 11.1 自动化测试（隔离副本里，全部通过）

不连专用服务器，不连 `localhost:3100`，不使用真实 Codex 账号。

1. 构建脚本的 5 项测试（第 3.5 节）；
2. 上下文构造：对一个固定的 `job.start` 样本，断言传给适配器的 `ctx` 逐字段符合 5.3 节；**用可注入的假适配器模块**（`runtimeModule` 注入点）捕获 `ctx`，不启动 Codex；
3. 环境处理：调用 `execute()` 前，执行线程的 `process.env` **没有** `PAPERCLIP_AGENT_KEY`、没有 `OPENAI_*`/`ANTHROPIC_*`，有正确的 `PAPERCLIP_API_URL` 和 `CODEX_HOME`；
4. 路径替换：覆盖 6.1、6.2、6.3 的每一条，含边界：缺项目目录、缺目录、目录在代理自身目录内、`..`、UNC、项目编号缺失；`paperclipWorkspaces` 被删除；`worktreePath` 被删除；**`config.cwd` 与 `context.paperclipWorkspace.cwd` 同时是本机目录**；
5. 历史摘要：有摘要则 `getFreshSessionHandoff` 返回它；无摘要返回 `null`，且上下文里**不残留**服务器路径或旧摘要字段；
6. 结果映射：白名单外字段被丢弃并有警告；`exitCode≠0` 无错误码时补码；适配器抛异常转成安全结果，不含堆栈；
7. `meta`/`usage` 校验失败被丢弃且有计数，任务不失败；
8. **进程树**（Windows）：第 8 节的 5 条路径逐条验证孙进程消失；`taskkill` 失败路径体现在结果里；
9. **技能物化**：
   - 目标不存在 → 复制；已存在同内容 → 跳过；已存在不同内容 → 原子替换；目标是符号链接 → 换成真实目录；复制失败 → 任务失败；
   - **在没有符号链接权限的条件下**运行：这条测试要在"当前用户没有创建符号链接权限"的环境里执行；如果副本所在电脑开着开发者模式，**用注入的"创建链接一律抛 EPERM"的 `fs` 替身**来模拟，并在报告里说明用的是哪一种；
10. `login`/`check`：用假的 `codex.exe`（一个会打印版本、能模拟登录成功的小程序）验证各检查项独立打印、退出码正确；
11. 版本：相同、窗口内不同、窗口外、预发布、解析失败，五种情形的行为；
12. 阶段 2 的 135 项测试**一项不改、全部仍通过**；阶段 1 协议与注册表测试无回归；`tsc --noEmit` 新增错误 0。

另外一项"集成"测试（仍在副本里自动化）：**用打包产物 + 真实 `codex.exe` 0.160.0 + 回环假模型服务**，经完整的 `job-runner` → 执行线程 → `execute()` 链路跑一个任务，断言结果、日志、用量、元数据帧都按协议发出。这是实验的可重复版本，**沿用实验里的假模型服务写法**，放在测试夹具里。

### 11.2 真实服务器上不依赖真实账号的验收

由负责人在成员电脑上执行，你写好可粘贴的 PowerShell 命令（Key 只走环境变量）：

- **B1**：`check`：各检查项都能独立打印；
- **B2**：用假模型服务（随代理仓库附带的一个测试脚本启动，只监听回环）和固定版本 Codex，配合真实服务器派一个任务：运行成功、日志里有 Codex 的 JSON 行、**日志里没有服务器路径**、没有令牌；
- **B3**：运行中取消：运行结束后进程列表里**没有 `codex.exe` 及其子进程**；
- **B4**：在**未开开发者模式的电脑**上运行：技能目录存在，提示词里有 paperclip 技能。

### 11.3 真实账号验收（由负责人执行，需要真实 Codex 登录）

- **S1**：`login` 完成设备登录，`check` 显示已登录；
- **S2**：派一个真实小任务：在成员的测试仓库里"读 README，追加一行，运行一条命令，写评论汇报，状态改为待评审"。**核对必须独立读回**：文件内容与哈希、智能体作者的评论、任务状态变化、运行次数、用量记录；
- **S3**：该智能体在任务里确实使用了 Paperclip 技能提供的接口（看运行日志里的 API 调用与 `X-Paperclip-Run-Id` 归属，活动日志里能看到）；
- **S4**：运行中取消，Codex 及其子进程全部消失；
- **S5**：超时（把 `maxRunSec` 设短）按预期收尾；
- **S6**：**会话续接**：同一任务再追加一条评论触发第二次运行，看日志是续接了上一次会话还是重置了会话；**不论结果如何如实记录**（这是 6.3 的未验证项）；
- **S7**：两个不同项目映射到两个本机目录，各派一个任务，目录互不串；
- **S8**：Codex 子进程环境里没有成员的长期 Key（让 Codex 执行打印环境变量名的命令，只检查变量名里有没有 `PAPERCLIP_AGENT_KEY`）。

## 12. 未决问题（不阻塞开工，但要在回报里列出你的发现）

1. **技能内容随代理打包 vs 服务器下发**：本阶段随代理打包，会有"成员机上的技能版本与服务器版本不一致"的风险。MANIFEST 里记录了版本信息；是否改为服务器在 `job.start` 里下发技能内容，需要负责人决定（涉及服务器协议改动）；
2. **`managedAiConnection` 的真实含义**：见 5.3，由实现者读代码并在回报里写出结论；
3. **服务器是否因路径不一致重置会话**：由 S6 回答；
4. **Codex 的 `PATH` 别名警告**：Windows 临时目录下 Codex 会警告"拒绝创建辅助程序"，实验中不影响结果，记录即可；
5. **代理运行环境**：本阶段仍在仓库检出里运行成员代理（用 `node member-agent/src/main.ts`）；怎么让成员机不依赖仓库（打包代理本身）属于阶段 6。

## 13. 禁止事项

- 不得编辑 `D:\paperclip`，不得向其应用补丁；不得重启、停止任何服务；
- 不得登录或写入专用服务器；不得连接 `localhost:3100`（唯一例外：与上一阶段一样，若需要核对本机 3100 的进程号，只允许对 `/api/health` 做前后两次只读请求）；
- 不得读取、复制、记录任何真实的 Codex 登录凭据（`auth.json`）、令牌、Key；测试用明显的假值；
- 不得 `git commit`、`git push`，不得加任何 AI 署名；
- 不得修改 `packages/adapters/codex-local`、`packages/adapter-utils`、`server/` 下的任何源码（只能打包它们）；
- 不得新增 `ws` 以外的运行时依赖；esbuild 只在构建脚本里使用，不进 `dependencies`；
- 不得提交构建产物（`member-agent/runtime/`）；
- 遇到本文没写清楚的地方，停下来回报，**不要自行决定**。

## 14. 回报格式

按总规格第 14 节，并包含：

- 新增与改动的文件清单、每个文件职责一句话；
- 第 11.1 节 12 项加集成测试逐条结论、对应测试名、完整输出（含失败过的）；
- 类型检查前后对比；阶段 1、阶段 2 测试重跑结果；
- 构建产物的 MANIFEST 样例（去掉本机绝对路径）和体积统计；
- B1–B4、S1–S8 的**可粘贴命令清单**；
- 第 12 节未决问题 1、2 的调查发现；
- 补丁路径与 `git apply --check` 结果；
- `D:\paperclip` 下**未出现**意外文件的证据（开工前后 `git status --porcelain` 对比）；
- 本机 3100 前后一致的证据（只读 `/api/health`）。
