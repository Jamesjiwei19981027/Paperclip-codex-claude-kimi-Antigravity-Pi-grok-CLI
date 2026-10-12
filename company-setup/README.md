# Windows 本机 Paperclip

源码目录：`D:\paperclip`，上游提交 `7e10dbe652ef0104f0a688a196fe8ea47b6f4b8e`。
界面：<http://127.0.0.1:3100/AI/agents/all>。组织树用右上角 Org chart view 按钮切换。

普通 PowerShell 后台启动：

```powershell
cd D:\paperclip
.\company-setup\start-paperclip.ps1
```

前台查看构建日志：`start-paperclip.ps1 -Foreground`。需要 Git Bash 执行上游 pnpm 的 POSIX 构建脚本，启动脚本已设置环境变量；首次构建慢，后续复用 Rust 缓存。

停止：`.\company-setup\stop-paperclip.ps1`。脚本拒绝停止仍有运行/待重试 Agent 任务的服务，按仓库和命令路径识别开发进程树，避免 Windows 仅停止外层包装器后留下 watcher。不要同时多开 pnpm dev。

数据保存在 `C:\Users\11580\.paperclip\instances\default`。不要删除数据库来排障。普通用户运行；管理员运行会被 PostgreSQL 拒绝。

公司：本地 AI 工程实验室，companyId `f278e2ee-4723-484c-84a7-4e8db38415bf`（2026-10-12 清空测试数据后重建）。

```text
Claude 技术总监（claude-opus-5，只拆派与方向验收）
└── Codex 技术负责人（gpt-5.6-sol，方案、派工、评审）
    ├── Pi 交叉验证执行者（justdowork/claude-opus-4-8，高级架构与疑难问题）
    ├── Kimi 主实现工程师（kimi-code/kimi-for-coding，CLI 引擎，主实现）
    ├── Gemini 实现执行者（Agy / gemini-3.8-flash-high，验证与辅助实现）
    └── Grok 质量与风险审查（grok-build，低优先级可选第二意见）
```

01–05、07 创建脚本首行均为当前 companyId；同名角色存在则返回现有角色，不会重复创建或更新。更改脚本后若要更新已创建角色，需在后台或 API 更新配置。

当前上游禁止新 Agent 使用 promptTemplate；独立职责通过版本化 instructionsBundle/AGENTS.md 每次注入。职责边界是模型指令，需持续通过任务审计检查执行；reportsTo、审批、预算停机是服务端约束。

已落实的兼容配置：

- Gemini 使用 gemini_local + cliFlavor=antigravity；后台直接调用 agy.exe，不执行 PowerShell 的 agy 函数。HTTP_PROXY/HTTPS_PROXY 需 `http://127.0.0.1:7897`，该本机代理必须运行。
- Codex 直接调用 npm 包内 codex.exe，避开 Windows .cmd 参数转换；extraArgs 使用绝对 model_catalog_json 路径，避免隔离 HOME 后相对文件丢失。
- Windows CLI 超时/取消会终止 .cmd 及其后代，相关真实进程树回归测试通过。
- npm 生成的 .cmd 包装文件不再经过 cmd.exe：adapter-utils 识别标准包装模板，直接启动背后的 node 脚本或 exe，多行提示词不会被 cmd 截断；认不出的手写包装（如 agy 目录的 gemini.cmd）仍走 cmd.exe。命令行总长仍受 Windows 约 32K 字符上限约束，Pi、Grok 的提示词文件方案保留。
- Kimi 使用 CLI 引擎，需 `KIMI_SHELL_PATH` 指向 Git Bash（本机 `D:\Program Files\Git\bin\bash.exe`，PATH 中的 bash 是 WSL）。不要改用 ACP 引擎：ACP 模式下命令在服务端代开的终端里执行，拿不到本次运行的 Agent 身份。Kimi 登录在 `kimi` 交互界面里输入 `/login`。
- Agent 运行身份 JWT 与动作签名密钥由源码 CLI 初始化，保存于实例 .env。不要将密钥写入公司说明或日志。

- 暂停/终止 Agent 时，服务端用记录的进程号判断旧进程是否已结束。Windows 会复用进程号；复用者若属于受保护进程，查询会被拒绝访问（EPERM），原逻辑将其视为仍在运行，导致终止永远卡住。现将 Windows 上的 EPERM 视为原进程已结束（Agent 进程与服务端同一用户，不会拒绝访问）。

新任务只派给 Claude，各层须自行创建下级任务；不能由操作者代造子任务作为验证。组织联调已于 2026-10-12 通过，测试任务和产物随后清空。

排障先看实例 logs。开发模式的服务日志也在终端；后台启动脚本的标准输出在 `.paperclip/windows-logs`，Agent run log 可直接从后台任务和 Runs 页面查看。

源码适配的针对性验证：

```powershell
pnpm exec vitest run packages/adapter-utils/src/server-utils.test.ts packages/adapters/gemini-local/src/server/cli-args.test.ts packages/adapters/gemini-local/src/server/parse.test.ts
pnpm --filter @paperclipai/adapter-utils typecheck
pnpm --filter @paperclipai/adapter-gemini-local typecheck
```

Gemini 全套测试原有六个 Windows 沙箱路径用例失败，已记录；未以本地安装验收替代全仓库 PR/发布检查。
