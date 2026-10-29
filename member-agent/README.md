# 成员代理 0.3.4

这个程序在成员 Windows 电脑上常驻，连接 Paperclip 并通过 echo、本机 Codex 或 CodeBuddy 执行任务。需要 Node 24.11.0 或更新版本。代理源码直接运行 TypeScript；Codex / Claude CLI 适配器在首次使用前单独打包到 `member-agent/runtime/`。Windows 安装包使用便携 Node，并提供交互登录、自检与用户级任务计划启动；安装说明见 `installer/README-成员安装说明.md`。

在仓库根目录安装唯一运行依赖：

```powershell
npm ci --prefix .\member-agent --workspaces=false --ignore-scripts --no-audit --no-fund
node .\member-agent\src\main.ts version
```

`member-agent/node_modules` 必须是独立目录，不能联接到服务器依赖目录。依赖精确固定为 ws 8.22.0。开发测试使用仓库既有的 Vitest、TypeScript 和类型声明；这些不是成员端的运行依赖。

配置默认位于 `%APPDATA%\paperclip-member-agent\config.json`，保存为无 BOM 的 UTF-8。echo 配置示例不包含 Key：

```json
{
  "serverUrl": "http://192.168.0.213:3100",
  "executor": "echo",
  "projectDirs": {},
  "defaultCwd": ""
}
```

Codex 配置示例（路径请替换成成员电脑上的绝对路径）：

```json
{
  "serverUrl": "http://100.64.0.1:3100",
  "executor": "codex",
  "projectDirs": { "项目 UUID": "E:\\workspace\\my-project" },
  "defaultCwd": "",
  "codexExecutable": "C:\\Tools\\Codex\\codex.exe",
  "codexHome": "C:\\Users\\me\\AppData\\Roaming\\paperclip-member-agent\\codex-home",
  "runtimeDir": "E:\\workspace\\paperclip\\member-agent\\runtime"
}
```

`codexHome` 必须是成员代理专属目录，不能使用 `%USERPROFILE%\\.codex`。每个项目的本机目录都必须已存在，并通过 `projectDirs` 映射；映射缺失时只使用非空 `defaultCwd`，不会退回代理自己的目录。`codexExecutable` 必须指向 `.exe`，不接受 `.cmd` 或 `.bat`。

在仓库根目录构建 Codex 运行时（构建产物不进入补丁）：

```powershell
node .\member-agent\scripts\build-runtime.mjs
```

首次使用 Codex 时执行设备登录；登录终端会直接显示 Codex 的交互输出，代理不会把其中的验证码或链接写入日志。登录只写入配置中的独立 `codexHome`：

```powershell
node .\member-agent\src\main.ts login
node .\member-agent\src\main.ts check
node .\member-agent\src\main.ts run
```

用不回显的提示将 Key 放入当前进程环境，避免写入文件或命令参数：

```powershell
$memberSecret = Read-Host '输入成员智能体的 API Key（不回显）' -AsSecureString
$memberBstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($memberSecret)
try { $env:PAPERCLIP_AGENT_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($memberBstr) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($memberBstr); $memberSecret.Dispose() }
node .\member-agent\src\main.ts check
node .\member-agent\src\main.ts run
# 结束后清除当前终端环境中的 Key
Remove-Item Env:PAPERCLIP_AGENT_KEY
```

可用 `--config <文件>` 指定其他配置。环境变量中的 Key 优先；未知配置字段会报错。文件允许其他账户读取时会显示权限警告及 `icacls` 收紧命令。HTTP 只允许回环、规定的私网/Tailscale 地址和无点号的内网主机名；其他地址使用 HTTPS。

`check` 收到服务器确认后退出；`run` 等待任务并自动重连。退出码：0 正常，1 内部错误，2 参数/配置错误，3 Key 被拒绝，4 传输或智能体被拒绝，5 本机已有实例。第一次 Ctrl+C 取消任务并退出，第二次立即强制退出。日志在 `%APPDATA%\paperclip-member-agent\logs`，按日滚动，启动时清理七天前日志。

echo 会写一条测试评论，再将工单改为 done；请只派发专门的测试任务。没有工单编号的任务只输出日志。执行器在独立 Worker 中运行，网络线程继续发送心跳；断线时取消任务并丢弃旧结果，重连不补发。日志队列最多 1000 帧或 8 MiB，超限只淘汰旧日志，保留结果。

为验收运行中取消或异常关闭，可以在配置中增加 `"echoHoldSec": 60` 后重新运行代理。echo 输出收到任务后等待指定秒数，再写回评论和状态；等待中取消会立即退出并且不写回。该值默认为 0，只接受 0–600 的整数，仅用于 echo 测试，真实执行器不得使用。验收后恢复为 0。

工具令牌只在内存中接收，有效期约一小时且不续期。Codex 执行器会把工具端点改写为代理连接的服务器来源，并在任务结束、取消、超时、断线或退出时清理已登记的进程树。

开发验证（在 member-agent 目录中）：

```powershell
node ..\node_modules\vitest\vitest.mjs run --config vitest.config.ts --cache=false --reporter=verbose
pnpm exec tsc --noEmit
```

自动化测试只监听随机回环端口，不访问 Paperclip 或专用服务器。Windows 进程树测试只创建和终止自己的测试子孙进程。阶段 3 的 Codex 集成测试使用本地回环假模型，不使用真实 Codex 账号或登录凭据。

## CodeBuddy 执行器

CodeBuddy 版安装包为 `PaperclipMemberAgent-0.3.4-codebuddy.zip`，内置固定版本 `@tencent-ai/codebuddy-code@2.169.0`。安装程序识别包内容选择执行器。首次运行 `start.ps1 -Mode login`，在交互界面输入 `/login`，完成后退出，再运行 `start.ps1 -Mode check`。登录与成员自己的 CodeBuddy 插件 / WorkBuddy 共用；代理只检查凭据文件存在性，从不读取或复制其内容。

配置使用 `executor: "codebuddy"`、`codebuddyEntry`（随包 `codebuddy/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy` 的绝对路径）、`codebuddyHome`（默认 `%APPDATA%\paperclip-member-agent\codebuddy-home`）、`runtimeDir`，以及可选 `codebuddyModel`。`codebuddyModel` 留空使用账号默认模型，不能填写 `claude-*`。改模型只需修改该字段后重启。`codebuddyHome` 不得指向成员个人 `.codebuddy`、其内部目录或指向该目录的联接；不会覆盖 `USERPROFILE` / `HOME`。

CodeBuddy 执行器复用 Claude CLI 的提示词、会话和输出解析；启动器转换系统提示词文件参数并过滤 Claude 默认模型。它仅使用 `--print --output-format stream-json`，输入仍为文本，且使用 `-y` 权限模式。需审批而无法非交互完成的动作由 CodeBuddy 拒绝。运行可取消；连续 15 分钟无输出会停止进程，另受任务最大运行时间限制。退出码为 0 但终态 `result.is_error=true` 仍算失败；未登录和不可用模型会给出中文修复提示。

Windows 上 Claude prompt cache 会直接复制 Paperclip 技能目录，不创建符号链接或目录联接；缓存目录名包含技能内容哈希。安装器和卸载器会在扫描配置目录前清理 `codebuddy-home\paperclip-runtime` 中可再生的旧缓存联接，只删除联接本身并保留其目标目录，缓存之外的重解析点仍会拒绝操作。

0.3.4 的缓存清理使用 Win32 宽字符 API 和扩展长路径：Windows PowerShell 5.1 与 pwsh 都能枚举及删除超过 260 字符的旧技能联接和普通缓存文件。目录联接、文件链接只删除入口；普通缓存递归删除，最后确认缓存目录已不存在。失败时报告中文原因和 Win32 错误码。复制缓存中的超长普通文件也在 ConfigDir 扫描前清除；缓存以外的链接仍拒绝操作。

沿用 0.3.3 的结果修正：仅在明确的 `result/subtype=success`、`is_error!==true`、退出码 0、未超时且无信号时，清除复用解析器因工具文本触发的 `claude_auth_required` 及其附带错误信息；其他失败保留。成员本机结束日志与服务端一致：非零退出、有错误码或超时均记失败，并显示错误码。CodeBuddy 的四种任务提示均说明：Windows PowerShell 5.1 发送含中文的 JSON 时，使用 `-Body ([Text.Encoding]::UTF8.GetBytes($json)) -ContentType 'application/json; charset=utf-8'`。

安装器对安装包清单全量计算 SHA-256；已安装目录自检和启动仅核对文件存在性与大小，以及 CodeBuddy 入口、package.json、package-lock.json 的哈希，避免重复读取全部依赖。自检仍验证 runtime 哈希、固定版本和共享登录存在性，再进行现有平台连接检查。开发中直接用本机 CLI 构造执行器验收可不连接服务器；生产自检要求使用完整安装包清单。

构建 CodeBuddy 安装包（依赖仅安装到构建器新建临时目录，不能向联接的仓库 `node_modules` 安装）：

```powershell
node .\member-agent\scripts\build-installer.mjs --executor codebuddy --node-zip <已有官方NodeZIP>
```

不传 `--executor` 仍构建 Codex 版 `PaperclipMemberAgent-0.3.4.zip`，不带 CodeBuddy 依赖或执行器。

禁止安装依赖的验收环境可使用构建模块的 `reuseVerifiedCodeBuddy(directory, manifestPath, expectedManifestSha256)`：先从独立可信记录核对旧交付 ZIP 的 SHA-256，再核对 ZIP 中清单并取得清单 SHA-256。此入口逐项校验旧 CodeBuddy 文件、文件集合、固定版本和 npm integrity 后才授予扫描凭据，不运行 npm。测试可通过 `PMA_VERIFIED_CODEBUDDY_DIR`、`PMA_VERIFIED_CODEBUDDY_MANIFEST`、`PMA_VERIFIED_CODEBUDDY_MANIFEST_SHA256` 指向该已验证副本；未提供这些变量时仍使用原来的临时目录安装流程。
