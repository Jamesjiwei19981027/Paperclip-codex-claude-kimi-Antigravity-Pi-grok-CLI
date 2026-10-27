# 成员代理：阶段 3

这个程序在成员 Windows 电脑上常驻，连接 Paperclip 并通过 echo 或本机 Codex 执行任务。需要 Node 24.11.0 或更新版本。代理源码直接运行 TypeScript；Codex 适配器在首次使用前单独打包到 `member-agent/runtime/`。本阶段不提供代理安装包、自动升级或开机自启。

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
