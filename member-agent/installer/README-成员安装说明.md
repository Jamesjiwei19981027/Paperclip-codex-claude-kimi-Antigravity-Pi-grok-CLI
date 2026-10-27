# 成员代理安装说明

先向负责人索取安装压缩包、服务器地址和你自己的智能体 Key。**不要把 Key 发给任何人，包括负责人。** 本机 Codex 登录只用于你自己的智能体。安装不需要管理员权限，也不需要先装 Node。

## 安装

将压缩包解压到普通目录，不要直接在压缩包中运行。用可信渠道拿到压缩包，并将 `Get-FileHash .\PaperclipMemberAgent-0.2.0.zip -Algorithm SHA256` 的结果与负责人单独提供的 SHA-256 核对。包内清单检查只能发现损坏或修改，不能证明来源。

在解压目录打开 PowerShell，运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

按提示输入服务器地址、已有的工作目录、Key，选择登录 Codex。Key 输入隐藏并由当前 Windows 用户加密保存，不会进入命令参数。服务器地址只填源地址，例如 `http://192.168.0.213:3100`；不带路径、查询参数或账号密码。公网必须用 HTTPS。此处的 Bypass 只影响这次脚本进程。

程序装在 `%LOCALAPPDATA%\Programs\PaperclipMemberAgent`；配置、加密 Key、独立 Codex 登录和日志放在 `%APPDATA%\paperclip-member-agent`。不要手动移动版本目录。安装器会注册你本人登录时启动的计划任务，不提升权限；公司策略禁止时会提示手动启动命令。

## 登录、自检与状态

```powershell
$install = Join-Path $env:LOCALAPPDATA 'Programs\PaperclipMemberAgent'
$version = (Get-Content (Join-Path $install 'current.txt') -Raw).Trim()
$start = Join-Path $install ('versions\' + $version + '\start.ps1')
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

启动器日志保留 7 天。配置错误、Key 无效或权限不允许时不会反复重试；修复后在任务计划程序启动 `PaperclipMemberAgent`，或运行上面的手动启动命令。意外崩溃会依次等待 10、30、60 秒，之后每次 5 分钟重试；正常停止不会自动重启。

## 升级和回滚

拿到新压缩包，核对哈希后解压，运行新包里的 `install.ps1`。现有配置、Key 和 Codex 登录可以沿用。安装器先停止启动器，再等当前任务结束，最多等待 60 秒；仍未结束会询问是否强制停止，选择否会取消升级。最多保留两个版本。

回滚时在解压目录运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Rollback
```

回滚会切回上一个版本，更新程序路径并重新启动。如果服务器要求更高版本，旧版会保持连接但拒绝任务，并明确提示升级。

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
