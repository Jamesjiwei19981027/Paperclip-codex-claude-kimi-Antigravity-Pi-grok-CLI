# 成员代理安装说明

先向负责人索取安装压缩包、服务器地址和你自己的智能体 Key。**不要把 Key 发给任何人，包括负责人。** 本机 Codex 登录只用于你自己的智能体。安装不需要管理员权限，也不需要先装 Node。

## 安装

将压缩包解压到普通目录，不要直接在压缩包中运行。用可信渠道拿到压缩包，并将 `Get-FileHash .\PaperclipMemberAgent-0.2.2.zip -Algorithm SHA256` 的结果与负责人单独提供的 SHA-256 核对。包内清单检查只能发现损坏或修改，不能证明来源。

在解压目录打开 PowerShell，运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

按提示输入服务器地址、已有的工作目录、Key，选择登录 Codex。Key 输入隐藏并由当前 Windows 用户加密保存，不会进入命令参数。服务器地址只填源地址，例如 `http://192.168.0.213:3100`；不带路径、查询参数或账号密码。公网必须用 HTTPS。此处的 Bypass 只影响这次脚本进程。

程序装在 `%LOCALAPPDATA%\Programs\PaperclipMemberAgent`；配置、加密 Key、独立 Codex 登录和日志放在 `%APPDATA%\paperclip-member-agent`。不要手动移动版本目录。安装器会注册你本人登录时启动、每 5 分钟检查一次的计划任务，不提升权限；已运行时不会重复启动。公司策略禁止时会提示手动启动命令。

## Codex 账号与代理

默认使用每位成员自己的 Codex 登录，并自动使用当前 Windows 用户的系统手动代理（例如 Clash 的 `127.0.0.1:7897`）。每个任务开始时重新读取，修改系统代理后不必重启成员代理。已有 `HTTPS_PROXY`、`HTTP_PROXY` 或 `ALL_PROXY` 环境变量优先（大小写均可）；仅设置 PAC 自动配置脚本时暂不支持，会提示后直连。代理只传给 Codex 子进程，Paperclip 服务器主机及本机回环地址加入 `NO_PROXY`；成员代理连接服务器始终直连。自检显示将使用的代理，不测试代理联网。

如需走本机中转程序，可在 `%APPDATA%\paperclip-member-agent\codex-home\config.toml` 中添加（将 `<端口>` 替换为中转程序的实际端口）：

```toml
openai_base_url = "http://127.0.0.1:<端口>/backend-api/codex"
```

这是中转地址示例；采用中转时使用的是中转背后的账号，而非默认的成员个人 Codex 账号。

## 登录、自检与状态

```powershell
$install = Join-Path $env:LOCALAPPDATA 'Programs\PaperclipMemberAgent'
$start = Join-Path $install 'start.ps1'
powershell -NoProfile -ExecutionPolicy Bypass -File $start -Mode login
powershell -NoProfile -ExecutionPolicy Bypass -File $start -Mode check
# 手动运行（关闭这个终端会影响代理）：
powershell -NoProfile -ExecutionPolicy Bypass -File $start
```

到看板查看自己的智能体是否在线。也可查看日志最后几行：

```powershell
$logs = Join-Path $env:APPDATA 'paperclip-member-agent\logs'
Get-ChildItem $logs -File | Sort-Object LastWriteTime -Descending | Select-Object -First 3 | ForEach-Object { Get-Content -LiteralPath $_.FullName -Tail 15 }
```

启动器日志保留 7 天。启动器本身被关闭后，看门狗在下一次 5 分钟检查时恢复。配置错误、Key 无效或权限不允许（退出码 2/3/4/5）时会保存停止标记；配置和加密 Key 都未改变时，重复启动只记一行日志，不会重试。修复配置或通过安装器替换 Key 后，下次看门狗检查自动恢复，也可手动启动。`-Mode check/login` 不受此停止标记限制。

代理正常停止（退出码 0）后，本次 Windows 登录期间看门狗不再拉起它，即使修改配置也不拉起；下次重新登录或执行上面的手动启动命令才恢复。在任务计划程序里点击运行仍属于计划任务启动，不等于手动执行脚本。意外崩溃仍依次等待 10、30、60 秒，之后每次 5 分钟重试。交互命令会临时使用 UTF-8 解码 Node 输出，结束后恢复控制台编码；日志始终为 UTF-8。

## 升级和回滚

拿到新压缩包，核对哈希后解压，运行新包里的 `install.ps1`。现有配置、Key 和 Codex 登录可以沿用。提示“沿用现有配置吗？[Y/n]”时，直接回车即沿用，输入 n 才重新填写；其他确认提示的默认选项不变。安装器先写维护锁、禁用计划任务并停止启动器，再等当前任务结束，最多等待 60 秒；仍未结束会询问是否强制停止，选择否会取消升级。维护期间不会启动任务执行，但仍可登录或自检；操作成功且自启任务重新注册后才解除维护锁。取消或失败后保持禁用，修复原因并重新运行安装器恢复。最多保留两个版本。

回滚时在解压目录运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Rollback
```

回滚会切回上一个版本，更新程序路径并重新启动；稳定的安装根目录 `start.ps1` 保留新看门狗保护，不应直接运行旧版本目录下的启动器。如果服务器要求更高版本，旧版会保持连接但拒绝任务，并明确提示升级。

## 卸载

运行压缩包里的 `uninstall.ps1`，或安装目录里的同名文件：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $env:LOCALAPPDATA 'Programs\PaperclipMemberAgent\uninstall.ps1')
```

卸载会列出删除路径，停止代理、删除自启任务和程序。配置与加密 Key、Codex 登录与模型设置、日志会分别询问是否删除，默认都保留。保留的数据仍在 `%APPDATA%\paperclip-member-agent`。

## 常见问题

自检显示 Codex 可执行文件、工具宿主或运行时缺失：重新获取完整安装包并安装。Codex 登录失败：运行上面的 `-Mode login`。服务器连不上：检查地址、网络和负责人提供的服务状态。Key 无效或被撤销：重新运行安装脚本，同版本覆盖并选择替换 Key；不要在聊天或命令行中粘贴 Key。

需要指定模型时，编辑本代理独立的 `%APPDATA%\paperclip-member-agent\codex-home\config.toml`，例如：

```toml
model = "gpt-5.4"
```

具体模型名请使用你账号可用的模型。不要修改个人 `%USERPROFILE%\.codex`。项目映射在配置文件 `projectDirs` 中添加，键为服务器项目 ID，值为本地已有目录；保留 JSON 格式，例如 `"projectDirs": { "项目ID": "D:\\项目目录" }`。修改配置后运行自检，再重启代理。

如果安全软件拦截，请先核对来源及哈希，再让负责人或 IT 确认。安装包尚未代码签名。不要关闭整机防护，也不要把 Key 或 Codex 登录文件发给他人。
