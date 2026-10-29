# 8. 安装包：构建、校验与分发

先读 `member-agent/scripts/build-runtime.mjs`、`member-agent/scripts/build-installer.mjs`、`member-agent/installer/install.ps1` 及 `member-agent/installer/README-成员安装说明.md`。以下命令用于后续经授权的实施；只编写文档时不执行构建或安装。

## 8.1 组成与来源

安装包包括便携 Node、执行器 CLI、成员代理源码、唯一第三方运行依赖 ws、适配器 runtime、Paperclip 技能、安装/卸载/启动脚本和说明。当前 Codex 除 codex.exe 还必须同目录带 codex-code-mode-host.exe；仅能查看版本不能证明工具宿主齐全。

以构建脚本为布局真值：包根放 install.ps1、uninstall.ps1、安装说明、MANIFEST.json；app 下放 start.ps1、node、codex、member-agent。安装后 app 内容进入 versions 下的版本目录，安装根另有稳定 start.ps1 和 uninstall.ps1。

1. 在 build-installer.mjs 中核对 NODE_VERSION、CODEX_VERSION 和 PINNED_BINARIES；在 `member-agent/package.json` 与 `member-agent/src/executors/echo.ts` 核对代理版本；在 `server/src/adapters/member-agent/settings.ts` 核对最低代理版本和工具固定版本。升级这些值要按既有负责人审批规则执行，不从待打包输入反推“可信哈希”。本文不记录任何固定 SHA 值。
2. Node 下载函数仅接受 Node 官方站点及同站 HTTPS 重定向，使用官方 SHASUMS256.txt 验 ZIP，再按 PINNED_BINARIES 验解压后二进制。即使用 --node-zip 指定本地 ZIP，现有脚本仍会获取官方校验清单，不是完全离线构建。
3. Codex 从已有依赖存储中的官方发行包读取，不现场安装；检查两个可执行文件的固定 SHA 与版本。新工具需先核实官方发布渠道、许可证、平台架构及全部配套文件，在规格中记录来源取得方式，再加固定哈希及验证代码。不得临时回退不明镜像。
4. runtime 构建入口固定打包本地 Codex 适配器，ESM、node24、createRequire banner，附带两个认证辅助文件与真实 Paperclip 技能目录。附属文件缺失会影响模块加载，不是“运行到登录时再补”。新工具复用适配器前同样实测加载时的资源依赖。

## 8.2 可照做的构建

在 Windows 的独立构建副本中确认 Node 满足源码运行要求、既有 esbuild/ws/CLI 可读，不安装共享依赖。执行：

```powershell
node member-agent/scripts/build-runtime.mjs
node member-agent/scripts/build-installer.mjs
```

第二条会重新构建 runtime。需要指定预下载 Node ZIP 时用 `--node-zip <本机ZIP路径>`；需要指定输出时用 `--out <允许范围内的目录>`。runtime 输出只能在成员代理 runtime 目录内，安装包输出只能在成员代理 dist-installer 目录内；脚本同时防目录联接逃逸。不要把 out 指到仓库根目录或共享主目录。

这两类目录是生成物，不是要求已存在的源码引用。runtime 生成 MANIFEST 记录 repoCommit、适配器版本、bundle/附属文件/技能哈希、esbuildVersion、nodeTarget 和 builtAt；外层清单记录 agentVersion、nodeVersion、codexVersion、runtimeManifest、repoCommit、builtAt、每文件 path/size/sha256。记录清单不等于对当前产品源码做了测试。

验证：在 `member-agent/test/build-runtime.test.ts` 对应场景中，把 runtime 复制到没有仓库依赖的独立临时目录后 import，确认 execute 可调用，缺附属文件时失败。`member-agent/test/build-installer.test.ts` 覆盖内容、哈希、扫描、输出越界、目录联接与可重复构建；两次构建比较只能排除内外两份 builtAt 及其引起的对应清单差异，不能随意忽略二进制或源码差异。

## 8.3 安装前的四道核查

1. **来源与 ZIP 哈希。** 可信渠道获取 ZIP，独立渠道核对 `Get-FileHash -LiteralPath <本机ZIP路径> -Algorithm SHA256`；不在技能中抄哈希。MANIFEST 只能发现修改/损坏，不能证明发布者身份。
2. **包内容。** scanInstaller 禁止 auth.json、config.json、专属 home、日志、测试、DPAPI 文件、环境文件、git 目录及未允许 JSON，拒绝符号链接/目录联接。文本扫描兼顾字节文本与 UTF-16LE；固定二进制只在规定路径且哈希正确时豁免文本扫描。新 CLI 不得把个人安装目录整棵复制进来。
3. **ZIP 路径。** archiveInstaller 逐文件创建 entry，将 Windows 反斜杠转 `/`。列出 ZIP entry，必须没有反斜杠、绝对路径或父目录段，中文文件名正常；不使用未经验证的 Compress-Archive 输出直接分发。
4. **安装自检。** install.ps1 按外层 MANIFEST 拒绝缺失、多余、损坏、非法路径；安装后执行稳定启动器的 check：

```powershell
$installRoot = Join-Path $env:LOCALAPPDATA 'Programs\PaperclipMemberAgent'
$startFile = Join-Path $installRoot 'start.ps1'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $startFile -Mode check
```

看到 Codex 可执行文件、工具宿主、版本、登录存在性、runtime 完整性五项通过，且连接/版本门控成功、退出码为 0 才通过。已有常驻实例时单实例锁可能返回 5，应按证据说明协调停机，不能把它当联网成功。check 不验证模型服务联网、不读取登录内容，也不重算完整 runtime 哈希。

## 8.4 编码与权限是安装契约

- 可执行 ps1 保存 UTF-8 带 BOM，兼容 PowerShell 5.1 中文源码解析；JSON、指针、日志由 Write-MemberText / UTF8Encoding(false) 写无 BOM。`member-agent/src/config.ts` 明确拒绝 BOM JSON。
- PowerShell 读取中文 JSON 指定 UTF8。调用 Node 前临时切换 Console.OutputEncoding 到 UTF-8，finally 恢复；这解决 CP936 控制台的解码问题，不要全局更改成员代码页。
- `member-agent/installer/uninstall.ps1` 中 Protect-MemberPath 创建只授当前 SID 的 ACL，用 SetAccessControl 写入，不使用需要 SeSecurityPrivilege 的 Set-Acl 重写保护路径。
- 长期成员 Key 仅隐藏输入，以当前用户 DPAPI 加密保存；启动器只在自身进程环境暂存解密值，退出恢复环境并释放缓冲。执行器凭据留在专属 home，不能进包、日志或报告。

验证：`member-agent/test/installer-scripts.test.ts` 覆盖两种 PowerShell 引擎、代码页与中文/空格路径；`member-agent/test/installer-lan-fixes.test.ts` 覆盖连续三次 ACL 设置和 CP936；`member-agent/test/installer-confirmation.test.ts` 验证只有“沿用现有配置”默认 Y，其他确认仍保持各自默认。

# 9. 看门狗、停止标记与版本维护

## 9.1 两层恢复机制

在 install.ps1 的 Register-MemberTask 中检查计划任务 PaperclipMemberAgent：当前用户登录触发，加每 5 分钟重复触发；Interactive、Limited、IgnoreNew、不限执行时长。运行安装根目录稳定启动器，参数 LaunchReason Scheduled。重复触发不是多个代理，仍受计划任务和成员单实例锁约束。

start.ps1 在 run 模式遇异常退出时依次等待 10、30、60、300 秒，之后每次 300 秒；正常 0，以及 2 配置错误、3 Key 无效、4 代理不允许、5 已有实例，不循环重试。check/login 只执行一次。启动器被杀时它自己的重试循环也消失，必须由外层计划任务恢复。

验证时分别结束确认属于本安装的 Node 和启动器，记录 PID/创建时间、结束时间、新进程时间、服务器重连时间；不能结束所有同名 Node/PowerShell。负责人曾实测 Node 约 10 秒、启动器 3 分钟内恢复；当前 5 分钟触发不能保证每次 3 分钟内，按真实结果报告，目标未达到就保留未通过项。

## 9.2 四个状态文件不可混淆

- `launcher-stopped.json`：启动器终止退出时原子写入，含 exitCode、Windows 登录会话 ID、配置/加密 Key 指纹。0 表示本次登录内有意停止，Scheduled 启动保持停止；新登录或手动运行脚本允许恢复。2/3/4/5 在配置与 Key 均未改变时抑制重复尝试，即使手动启动也不会重试；修复配置或替换 Key 后才解除。check/login 不受此标记限制。
- `maintenance.flag`：安装根目录的维护围栏。升级、回滚、卸载前写入；随后先禁用并停止计划任务，阻止已经排队的看门狗拉起。安装成功且计划任务注册成功后清除；失败/取消保留，重新运行安装器恢复，不可无条件删除。
- `launcher-stop.request`：安装器向特定 pid/startedAt 发的 drain/force 请求；`member-agent/src/install-control.ts` 轮询，先不接新任务，再等当前任务结束，或按明确请求停止。
- `agent-control.json`：当前代理身份 pid/startedAt；安装器同时验证可执行文件路径、进程创建时间与配置参数。不是凭这个文件中任意 PID 就有权终止进程。

关键顺序：切换文件与配置 → check → 重新注册计划任务成功 → 清 maintenance → 清 launcher-stopped → Start-ScheduledTask。安装/回滚 drain 导致旧代理退出 0，若未清 launcher-stopped，同次登录下新计划任务会被误挡。修复位置是 install.ps1 的注册后分支，不是删掉所有正常停止保护。

验证：参照 installer-lan-fixes 的正常停止、终止错误、维护锁和看门狗测试；真机补测同版本覆盖和回滚后立即上线，不能等注销登录后才算成功。

## 9.3 升级、覆盖、回滚、卸载

1. 新包校验后运行 install.ps1，沿用现有配置默认 Y；Key、独立登录和项目映射保留，只更新版本相关程序路径。当前 installer 会先暂存并校验文件，再 drain；最多等待 60 秒，仍忙时才询问是否强制停止。
2. 新旧版本用 current.txt / previous.txt 指针管理，最多保留当前与上一版本。同版本覆盖也使用暂存与备份，验证失败不得损坏已安装版本。
3. 回滚运行新包中的 `install.ps1 -Rollback`，程序路径随指针切换；继续使用安装根稳定启动器，避免回滚掉看门狗保护。最低版本门控仍有效。
4. 卸载运行安装根的 uninstall.ps1；先维护、禁用任务、核实身份、drain、删除任务，再删除程序目录；配置/加密 Key、独立登录、日志分别确认，默认保留。
5. 失败或取消后记录维护锁、任务禁用状态和指针，不宣称自动恢复；按原因修复后重新运行安装器。不得通过强杀其他成员进程“解锁”。

验证：`member-agent/test/install-control.test.ts`、`member-agent/test/install-control-integration.test.ts`、installer-scripts 的安装→升级→回滚→卸载和同版本失败保护；真机流程见 I6、I8 及覆盖安装补充项。

# 10. member_agent 专属时间控制

阈值集中在 `server/src/services/member-agent-time-policy.ts`，服务逻辑在 `server/src/services/member-agent-time-control.ts`，输出更新时间的接线在 `server/src/services/heartbeat.ts`。保持 company 范围和 member_agent 适配器过滤，不影响其他执行器路径。

- **A：15 分钟无输出停止。** 依据 lastOutputAt 等运行时间调用既有取消路径，记录 member_agent_output_silence；通知是“已发停止请求”，不能当成本机进程已停止。仍须看远程取消确认和进程收尾。
- **B：10 分钟未开工提醒。** 覆盖排队/待重试，以及 busy/offline/not_accepted 等未开工失败，发系统提醒，不自动改派。
- **C：派活满 2 小时未完成。** 系统提醒并加“成员任务超期”标签；按派活阶段计时，不是每次进度更新重置。完成、取消、改派或重开按服务规则清理/重算。

实现要求：CLI 有输出就及时生成 job.log，保留换行，不能长时间只缓存最后结果；不能用假日志刷活掩盖实际卡死。当前服务端也将接收到的结构化事件/用量等视为输出并更新时间，心跳本身不算；不能把这一实现说成“只看 stdout”，也不能因此省略看板必需的日志流。

验证：`server/src/__tests__/member-agent-time-control.test.ts` 用可注入阈值/时钟验证临界值、幂等通知、公司隔离、适配器隔离和阶段变化；真实短任务记录逐行输出时间戳及停止确认。不要为验证在生产临时缩短阈值。设计依据可看 `doc/plans/2026-10-28-member-agent-time-control.md`，现状以代码为准。
