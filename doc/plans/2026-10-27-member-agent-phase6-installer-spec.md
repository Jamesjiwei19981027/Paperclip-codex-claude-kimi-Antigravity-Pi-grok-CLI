# 成员代理阶段 6 规格：Windows 安装包

日期：2026-10-27  
前置：阶段 1–3 完成，真实账号验收 S1–S8、B1–B4 全部通过（见 `2026-10-25-member-agent-phase3-evidence/report.md`）。  
上位文档：[总规格](2026-10-25-member-agent-implementation-spec.md)。总规格第 2 节硬性规则、第 14 节回报格式继续有效。

## 0. 为什么先做这个

没有安装包，成员代理只能在装了完整仓库和 Node 的电脑上运行，第二台电脑无法接入，两人并行（阶段 7）就做不了。本阶段的目标是：**一台什么都没装的 Windows 电脑，拿到一个压缩包，非管理员身份运行一次安装脚本，就能让成员智能体开机自动上线、接任务干活。**

## 1. 范围

### 本阶段要做

1. 构建脚本：在负责人电脑上一条命令产出安装压缩包；
2. 安装包内容：便携版 Node、成员代理源码、`ws` 依赖、Codex 适配器运行包、固定版本 Codex（含工具宿主）、安装/启动/卸载脚本、说明；
3. 安装脚本：校验文件、按版本目录安装、写配置、加密保存 Key、引导 Codex 登录、自检、注册开机自启；
4. 启动脚本：解密 Key、设置环境、启动代理、异常退出后自动重启；
5. 升级与回滚：装新版本不丢配置、Key、登录；能切回上一个版本；
6. 卸载脚本；
7. 代理版本校验：服务器能看到每个成员代理的版本，版本不符合要求时代理拒绝接任务并明确提示。

### 本阶段不做（做了算偏离）

- **自动下载并安装新版本**：服务器托管安装包、代理自行下载替换。这需要服务器增加文件托管和签名校验，单独作为阶段 6b，本阶段只做"手动运行新安装包升级"和"版本不符时拒绝接任务"；
- 代码签名（需要购买证书，单独决策）；
- 图形界面、托盘图标；
- Windows 服务（理由见 4.5）；
- 非 Windows 系统；
- 修改服务器协议以外的服务器逻辑（第 7 节的版本校验是唯一允许的服务器改动）。

## 2. 关键设计决定（附理由）

| 决定 | 理由 |
|---|---|
| **带便携版 Node，不要求成员安装 Node** | 成员电脑不一定有 Node，版本也不可控；便携版解压即用，不改系统环境变量 |
| **直接带 TypeScript 源码，不再打包成单文件** | 代理现在就靠 Node 24 原生去类型运行，执行线程用 `new URL('./executor-worker.ts')` 加载、执行器按文件动态加载；改成单文件要改加载方式，带来新风险。安装目录不在 `node_modules` 之下，原生去类型可用 |
| **Codex 程序随包携带** | 版本固定为 0.160.0，与服务器 `pinnedCodexVersion` 一致；必须同时带 `codex.exe` 和 `codex-code-mode-host.exe`（S2 首次失败的教训） |
| **按版本分目录安装** | 升级时新旧版本并存，回滚只是切换指针，不会出现"升级到一半坏掉" |
| **Key 用 Windows 当前用户加密保存** | 开机自启必须有持久的 Key，但不能明文落盘。PowerShell 的 `ConvertFrom-SecureString` 使用 Windows 数据保护（DPAPI），只有同一台电脑、同一个 Windows 用户能解密；启动脚本解密后只放进代理进程的环境变量 |
| **用"任务计划程序"在登录时启动，不用 Windows 服务** | Codex 登录、配置目录都属于成员本人的 Windows 账号；服务默认以系统账号运行，拿不到这些；任务计划程序可以在非管理员下为当前用户注册 |
| **安装不需要管理员权限** | 成员电脑多半没有管理员权限，全部装在用户目录 |

## 3. 构建

### 3.1 命令

在负责人电脑的 `D:\paperclip` 下：

```text
node member-agent/scripts/build-installer.mjs [--node-zip <已下载的 Node 压缩包路径>] [--out <输出目录>]
```

默认输出到 `member-agent/dist-installer/`（加入 `.gitignore`，不得提交）。输出路径一律 `path.resolve` 并断言位于 `member-agent/dist-installer/` 之内（沿用阶段 3 的教训：相对路径曾把构建产物写进仓库根目录）。

### 3.2 便携版 Node

- 版本固定为一个 Node 24 LTS 的具体版本（与负责人电脑当前一致或更新的 24.x，写死在构建脚本里），平台 `win-x64`；
- 来源只允许 nodejs.org 官方：`https://nodejs.org/dist/v<版本>/node-v<版本>-win-x64.zip`；
- 必须用同目录官方 `SHASUMS256.txt` 校验压缩包 SHA-256，不一致就失败；
- 支持 `--node-zip` 使用已下载的压缩包，同样必须校验；
- 只取出 `node.exe` 和许可证文件，不带 npm、corepack（成员电脑不需要安装依赖）。

### 3.3 包内结构

```text
PaperclipMemberAgent-<代理版本>.zip
  install.ps1
  uninstall.ps1
  README-成员安装说明.md
  MANIFEST.json                  # 每个文件的 SHA-256、大小，以及各组件版本
  app/
    node/node.exe
    node/LICENSE
    member-agent/src/...         # 源码原样复制（不含 test/）
    member-agent/package.json
    member-agent/node_modules/ws/...
    member-agent/runtime/...     # build-runtime 的产物（适配器单文件、附属脚本、skills/paperclip）
    codex/codex.exe              # 0.160.0
    codex/codex-code-mode-host.exe
    start.ps1
```

### 3.4 Codex 程序来源

- 从仓库已安装的 `node_modules\.pnpm\@openai+codex@0.160.0-win32-x64\...\bin\` 取两个 exe（该包由 pnpm 按锁文件完整性值安装）；
- 构建时运行 `codex.exe --version` 必须输出 `0.160.0`，否则失败；
- 两个 exe 的 SHA-256 写入 MANIFEST。

### 3.5 MANIFEST.json

字段：`agentVersion`、`nodeVersion`、`codexVersion`、`runtimeManifest`（嵌入 build-runtime 产出的 MANIFEST）、`builtAt`、`repoCommit`、`files`（每个文件的相对路径、大小、SHA-256）。

### 3.6 构建要求

- 构建前先跑 `build-runtime`，确保运行包与当前源码一致；
- 产物里**不得包含**：任何 Key、令牌、密码；`auth.json`；`codex-home`；`test/` 目录；日志；本机配置。构建末尾扫描整个产物，发现以下任一即失败：文件名为 `auth.json`、`config.json`（`member-agent/package.json` 以外的 JSON 配置除外，按白名单判断）；内容匹配 `pcp_`、`sk-` 加长串、`BEGIN ... PRIVATE KEY`；
- **官方二进制按固定哈希放行**（2026-10-27 负责人裁定）：`app/node/node.exe`、`app/codex/codex.exe`、`app/codex/codex-code-mode-host.exe` 不做文本扫描，改为在构建脚本中写死各自的 SHA-256 并在构建时核对，不一致即失败。放行只按"相对路径 + 固定 SHA-256"精确匹配；同名但哈希不同的文件照常扫描。其余所有文件的文本扫描零例外，不设任何文本白名单。MANIFEST 中标注这三个文件为"哈希锁定，未做文本扫描"。升级 Node 或 Codex 版本时，固定哈希须经负责人确认后更新。理由：扫描是为了防止我们自己的凭据混入；官方文件只要哈希一致就不可能含有我们的凭据，比在大型二进制中维护文本例外更可靠；
- 构建可重复：同一源码两次构建，内容必须一致。比较时只排除两个时间戳（2026-10-27 负责人裁定）：外层 MANIFEST 的 `builtAt`，以及 `app/member-agent/runtime/MANIFEST.json` 内的 `builtAt`；该文件按 JSON 去掉 `builtAt` 后比较，其余所有文件按路径、大小、SHA-256 比较。不得在打包副本中改写时间戳；不得扩大排除范围。

## 4. 安装

### 4.1 运行方式

成员解压后，在压缩包目录打开 PowerShell 执行：

```text
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

`-ExecutionPolicy Bypass` 只作用于这一个进程，不改系统设置。

### 4.2 脚本兼容性（硬性要求）

- 所有 `.ps1` 必须能在 **Windows PowerShell 5.1**（成员电脑默认自带）和 PowerShell 7 下运行；
- 文件编码 **UTF-8 带 BOM**（B3 验收时，无 BOM 的中文脚本在 5.1 下报"字符串缺少终止符"）；
- 不使用 5.1 不支持的语法（`??`、`?.`、三元运算符、`&&`/`||` 管道链等）；
- 路径一律用 `Join-Path`，必须支持用户名和路径中含中文、空格；
- 首先对压缩包内所有文件执行 `Unblock-File`（去掉"来自网络"的标记，否则可能被拦截）。

### 4.3 安装步骤

1. **校验**：按 MANIFEST 逐个核对 SHA-256，任一不符则停止，提示"安装包已损坏或被修改，请重新获取"；
2. **复制**：把 `app/` 复制到 `%LOCALAPPDATA%\Programs\PaperclipMemberAgent\versions\<代理版本>\`；同版本已存在时询问是否覆盖；
3. **切换当前版本**：写 `%LOCALAPPDATA%\Programs\PaperclipMemberAgent\current.txt`（内容为版本号）；记录上一个版本到 `previous.txt`；
4. **配置**（`%APPDATA%\paperclip-member-agent\config.json`）：
   - 已有配置：显示服务器地址等关键字段，询问是否沿用；
   - 新安装：交互询问服务器地址（校验格式，沿用代理的明文自检规则）、默认工作目录（必须已存在）；项目映射可留空，README 说明以后如何添加；
   - `codexExecutable`、`runtimeDir` 指向当前版本目录；`codexHome` 固定为 `%APPDATA%\paperclip-member-agent\codex-home`；
   - 写完后收紧文件权限，只允许当前用户读写；
5. **Key**：用隐藏输入读取智能体 Key，`ConvertFrom-SecureString` 加密后写入 `%APPDATA%\paperclip-member-agent\agent-key.dpapi`，收紧权限；已存在时询问是否替换；**任何情况下不得把明文写入文件、日志、屏幕**；
6. **登录**：检查 `codex-home\auth.json` 是否存在；不存在则询问"现在登录 Codex 吗"，是则调用代理的 `login` 命令；
7. **自检**：通过启动脚本以 `check` 模式运行，把每项结果显示给成员；任何一项失败都提示原因和修复办法，但不回滚已安装的文件；
8. **开机自启**：注册当前用户的计划任务（第 4.5 节）；询问"现在启动吗"，是则立即启动该任务；
9. 结束时显示：安装位置、日志位置、如何查看状态、如何卸载。

### 4.4 启动脚本 `start.ps1`

- 读取 `current.txt` 定位版本目录；
- 解密 `agent-key.dpapi`，设置到**本进程**的 `PAPERCLIP_AGENT_KEY`，随即清除中间变量；
- 以 `app\node\node.exe` 运行 `member-agent\src\main.ts run --config <配置>`（或 `check`，由参数决定）；
- **退出后自动重启**（仅 `run` 模式；2026-10-27 负责人裁定，消除原 4.4 与 8.1 第 7 项的冲突）：
  - 退出码 1，以及任何其他非预期退出（崩溃、被信号终止、退出码不在本表内）：按 10 秒、30 秒、60 秒、之后每 5 分钟的节奏重启；
  - 退出码 0：有意的正常停止，不重启（开机自启、隐藏运行时，0 只来自有意停止，例如升级、卸载时停止代理；见 0 也重启会与这些流程冲突）；
  - 退出码 2、3、4（配置错误、Key 无效、智能体不被允许，见阶段 2 规格）：不重启，写日志后结束，避免拿错误的 Key 无限重试；
  - 退出码 5（已有实例在运行）：直接结束；
  - `check` 模式只执行一次，原样返回代理的退出码；
- 升级、卸载时停止代理：先停止计划任务（结束启动脚本本身），再等待代理进程结束，不依赖退出码阻止重启；
- 自己的日志写到 `%APPDATA%\paperclip-member-agent\logs\launcher-YYYYMMDD.log`，保留 7 天；绝不记录 Key。

### 4.5 开机自启

- 用 `Register-ScheduledTask` 注册当前用户的计划任务，名称 `PaperclipMemberAgent`；
- 触发：当前用户登录时；
- 运行：`powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File <current 版本>\start.ps1`；
- 设置：允许按需运行；电池供电时也运行；不设运行时长上限；已在运行时不启动新实例；
- 不需要管理员权限；如果注册失败（个别公司策略禁止），给出明确提示，并告诉成员可以手动运行 `start.ps1`。

## 5. 升级、回滚与卸载

### 5.1 升级

- 成员运行新版本的 `install.ps1` 即可；脚本检测到已有安装时走升级流程：校验 → 复制到新版本目录 → 停止计划任务和正在运行的代理（等待当前任务结束，最多等 60 秒；仍在运行则询问是否强制停止）→ 切换 `current.txt` → 沿用配置、Key、Codex 登录 → 更新配置里的程序路径 → 自检 → 重启计划任务；
- 旧版本目录保留，最多保留最近 2 个版本，更早的自动删除。

### 5.2 回滚

- `install.ps1 -Rollback`：把 `current.txt` 切回 `previous.txt` 记录的版本，更新配置里的路径，重启代理。

### 5.3 卸载 `uninstall.ps1`

- 删除计划任务，停止代理；
- 删除 `%LOCALAPPDATA%\Programs\PaperclipMemberAgent\`；
- **分别询问**是否删除：配置和加密 Key、Codex 登录（`codex-home`）、日志。默认都不删（遵循"不可逆操作先确认"）；
- 列出将删除的内容后再执行。

## 6. 运维说明（README 内容要点）

面向成员，用中文、说人话：

- 安装前需要从负责人处拿到：服务器地址、自己的智能体 Key；
- 安装、登录、查看状态（看日志最后几行，或在看板上看自己的智能体是否在线）、升级、卸载各一段；
- 常见问题：自检某项失败怎么办；Key 被撤销后如何换（重新运行安装脚本选择替换 Key）；需要指定模型时在 `codex-home\config.toml` 里写什么；
- 明确提示：**不要把 Key 发给任何人，包括负责人**；电脑上的 Codex 登录只用于你自己的智能体。

## 7. 代理版本校验（唯一允许的服务器改动）

- 服务器在 `member-agent/settings.ts` 同处增加常量 `minimumAgentVersion`（本阶段设为本次发布的版本）；
- `hello.ack` 中带上 `minimumAgentVersion`；
- 代理收到后比较自己的版本：低于要求时，**保持连接但拒绝所有任务**，每次收到任务都回 `job.result`（`errorCode: "member_agent_version_outdated"`，中文说明当前版本和要求版本）；同时在本机日志和控制台显示"请运行新安装包升级"；
- 这样负责人在看板上能看到明确原因，而不是成员智能体莫名失败；
- 代理的 `hello` 已经上报 `agentVersion`；若看板智能体详情页现在看不到这个值，在回报里说明，不要为此修改界面（界面展示留待后续决定）。

## 8. 验收

### 8.1 自动化（隔离副本内）

1. 构建产物结构与 3.3 一致，MANIFEST 字段齐全、哈希正确；
2. 构建两次，按 3.6 节的比较规则内容一致（只排除外层与运行包清单中的两个 `builtAt`）；
3. 敏感内容扫描能拦截：在测试夹具里放入假的 `auth.json`、含 `pcp_` 假串的文件，构建必须失败；
4. 输出路径越界（`..`、仓库根目录）时构建失败，且仓库内不出现新文件（对比 `git status --porcelain`）；
5. 代理版本校验：低于、等于、高于 `minimumAgentVersion` 三种情况；低于时任务被拒绝且错误码正确；
6. 所有 `.ps1` 文件：是 UTF-8 带 BOM；用 Windows PowerShell 5.1 的解析器和 PowerShell 7 的解析器分别解析，均无语法错误；
7. 启动脚本的重启策略：用一个会以指定退出码退出的假代理，验证 1 和非预期退出会重启，0、2、3、4、5 不重启，`check` 模式只执行一次，重启间隔正确（用可注入的等待函数，不真等）；
8. 安装脚本在**测试模式**下（参数指定安装根目录、配置目录，不注册计划任务、不读真实 Key）完整走一遍安装、升级、回滚、卸载，检查目录、`current.txt`、`previous.txt`、配置路径的变化；
9. 成员端原有测试全部仍通过；服务端成员智能体相关测试无回归；类型检查新增错误 0。

### 8.2 真实环境（负责人和成员执行，执行者写好可粘贴的命令）

在**一台没有仓库、没有安装 Node 的 Windows 电脑**上，以**非管理员**身份：

- **I1**：解压后 `install.ps1` 全程走完，自检五项通过；
- **I2**：注销后重新登录，代理自动上线（看板显示该智能体连接；由负责人读回）；
- **I3**：派一个类似 S2 的真实小任务，成功并写回；
- **I4**：在任务管理器结束代理的 `node.exe`，代理在 30 秒内自动重启并重新连接；
- **I5**：在整台电脑上搜索 Key 明文，找不到（检查安装目录、配置目录、日志、计划任务定义）；
- **I6**：制作一个版本号加一的安装包，运行升级：配置、Key、Codex 登录全部保留，看板上显示新版本已连接；再执行回滚，回到旧版本；
- **I7**：服务器把 `minimumAgentVersion` 设为高于旧版本，旧版本代理拒绝任务且看板上能看到原因（可与 I6 合并）；
- **I8**：卸载：计划任务和程序目录被删除；选择"保留"的用户数据确实保留；
- **I9**（如条件允许）：在 Windows 用户名或安装路径含中文的电脑上重复 I1。

## 9. 安全要点

- 安装包不含任何凭据；Key 只在成员电脑上以 DPAPI 加密保存；
- MANIFEST 校验能发现传输损坏和被改动，但**不能证明安装包来自负责人**（没有代码签名）。分发时负责人应通过可信渠道发送压缩包，并单独告知压缩包的 SHA-256，供成员核对；
- 计划任务以成员本人身份运行，不提升权限；
- 便携版 Node 只在代理进程中使用，不加入系统 PATH，不影响成员电脑上已有的 Node。

## 10. 已知限制与后续

- 阶段 6b：服务器托管安装包、代理自动下载升级、安装包签名校验；
- 代码签名证书：需要负责人决定是否购买；没有签名时，部分电脑的安全软件可能拦截，README 中说明处理办法；
- 安装包体积预计 120 MB 左右（压缩后），大部分是 Codex 程序；
- 阶段 3 已知问题照旧：共享恢复提示中的原生工具名、父进程先退出时的遗留子进程、服务器不下发模型。
