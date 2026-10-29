# 11. 已知坑清单

每条都按“现象 → 根因 → 修复位置 → 验证方法”排查。负责人提供的真机时间和团队数据属于历史观察；代码/测试证明机制，不能替代下一版的真机结果。所有公开证据先去除真实地址、人员、电脑标识和成员目录。

1. **PowerShell 5.1 中文脚本解析错误、JSON 读不进。**
   - 根因：PS 5.1 默认编码与 Node JSON 编码契约不同；给所有文件统一加 BOM 也会使 config.json 被拒绝。
   - 位置：`member-agent/installer/install.ps1`、`member-agent/installer/start.ps1`、`member-agent/installer/uninstall.ps1`；Write-MemberText 写无 BOM UTF-8，Read-MemberJson 指定 UTF8；`member-agent/src/config.ts` 拒绝 BOM JSON。
   - 验证：`member-agent/test/installer-scripts.test.ts` 的 BOM、双引擎解析、临时配置清理；真机查 ps1 前三字节有 BOM，JSON 没有，check 成功且中文提示正常。

2. **CP936 下控制台中文乱码。**
   - 根因：Node 输出 UTF-8，被 PowerShell 按旧控制台编码解码。
   - 位置：install.ps1 的验证与 Invoke-MemberCommand、start.ps1 的 Node 调用使用临时 Console.OutputEncoding，finally 恢复；`member-agent/src/config.ts` 的 ACL 查询通过 UTF-8 base64 返回，避免按 UTF-8 直接解码本机 icacls 字节。
   - 验证：`member-agent/test/installer-lan-fixes.test.ts` 的 code page 936 场景；中文 Windows 用户名真机跑安装与 check，控制台和 UTF-8 日志无乱码，退出后原编码未改变。

3. **第一次安装成功，第二次/升级 Set-Acl 报 SeSecurityPrivilege。**
   - 根因：对已保护对象 Set-Acl 会尝试重写 SACL，需要普通用户没有的特权。
   - 位置：uninstall.ps1 的 Set-MemberAcl / Protect-MemberPath，改用当前 SID 的 FileSecurity/DirectorySecurity 和 SetAccessControl，不请求提升权限。
   - 验证：installer-lan-fixes 连续三次设置真实目录/文件 ACL，ACL 不漂移；真机非管理员连续安装、升级通过，私有访问规则仍在。

4. **重装成功却一直不上线。**
   - 根因：旧代理 drain 以 0 退出，写了本次登录正常停止标记，新计划任务被挡住。
   - 位置：install.ps1 在成功重新注册计划任务后、启动前清除 launcher-stopped.json；start.ps1 保留正常停止保护。
   - 验证：安装→运行→同版本覆盖→立即看板上线，再升级/回滚各一次；确认不是靠注销或手删标记才恢复。检查注册失败时仍保留维护围栏。

5. **CLI 直连海外服务 Reconnecting，多次重试后失败。**
   - 根因：Windows 系统代理不自动等于 CLI 的代理环境；平台在线也不说明模型服务可达。
   - 位置：`member-agent/src/executors/codex-proxy.ts` 的 HKCU 手动代理解析、NO_PROXY，`member-agent/src/executors/codex.ts` 的子进程 env 与代理凭据脱敏。
   - 验证：`member-agent/test/codex-proxy.test.ts`、`member-agent/test/codex-executor.test.ts`；真机对比直连与 HTTPS_PROXY 子进程模式。历史观察为直连 Reconnecting 5/5、约 127 秒失败，设置代理后约 21 秒完成；只作为诊断线索，非性能承诺。

6. **中文 Windows 用户名、中文/空格路径报找不到文件。**
   - 根因：硬编码用户路径、字符串拼命令、编码或通配符解释错误；提升权限还会切换用户与 DPAPI 上下文。
   - 位置：安装脚本使用 APPDATA/LOCALAPPDATA、Join-Path、LiteralPath 和带引号参数；`member-agent/src/codex-cli.ts` 使用 spawn/execFile 参数数组。
   - 验证：installer-scripts 的中文/空格临时目录加 I9 非管理员真机；负责人已提供“中文 Windows 用户名 + PS 5.1 + CP936 安装运行通过”观察，下一执行器仍须重验，不能据此宣称其凭据隔离也通过。

7. **ZIP 在另一种解压器中变成奇怪文件名或层级。**
   - 根因：entry 使用 Windows 反斜杠，跨工具解释不一致。
   - 位置：`member-agent/scripts/build-installer.mjs` 的 archiveInstaller 用 ZipArchive 逐条创建正斜杠相对路径。
   - 验证：`member-agent/test/build-installer.test.ts` 的 forward-slash entries/中文名；列所有 entry 无反斜杠，解压后 MANIFEST 校验通过。

8. **npm 的 codex.cmd 能在终端运行，成员执行器却拒绝/无法启动。**
   - 根因：npm .cmd/.bat 是 shell 垫片，当前 Codex 安全契约只接受绝对 .exe，不通过 shell 执行。
   - 位置：`member-agent/src/config.ts`、codex.ts、codex-cli.ts 的校验；安装包提供官方 codex.exe，配套工具宿主必须同版本同目录。
   - 验证：`member-agent/test/codex-cli.test.ts` 和 codex-executor 的 non-exe 拒绝测试；check 五项及真实 code-mode 文件读取均通过。其他 CLI 的脚本入口须单独设计，不能删掉 Codex 的限制来迁就。

9. **适配器有返回值，平台却少字段或报无效协议。**
   - 根因：直接透传本地适配器额外字段；成员与服务端都有严格白名单。
   - 位置：codex.ts 的 RESULT_FIELDS/safeResult 丢弃未知顶层字段并告警；`member-agent/src/protocol.ts` 和 `server/src/adapters/member-agent/execute.ts` 拒绝未知/无效字段。
   - 验证：`member-agent/test/job-runner.test.ts` 的未知字段失败、`server/src/adapters/member-agent/protocol.test.ts` 的严格契约；模拟额外字段和错误嵌套值。不能把“Codex 筛选后丢弃”误称服务端会自动兜底。

10. **看板只有日志，成员运行没有助手转写或工具过程。**
    - 根因：member_agent 未注册 UI 解析器时落到 process；或 stdout JSONL 被改写/最终才发送。
    - 位置：`ui/src/adapters/member-agent/index.ts` 按行顶层 type 分流 Claude/CodeBuddy stream-json 与 Codex JSONL；`ui/src/adapters/registry.ts` 注册；新增格式先实测是否有类型歧义。
    - 验证：`ui/src/adapters/member-agent/index.test.ts` 的真实脱敏 fixture、分块 JSON 和工具事件；运行未结束前看板逐条出现 tool_call/tool_result，不能只截图最终 summary。

11. **启动器退出 0xC000013A，被杀后等到下次登录才拉起。**
    - 根因：只有登录触发，启动器一死，内部重试循环也死。
    - 位置：install.ps1 的 Register-MemberTask 增加每 5 分钟看门狗，start.ps1 有维护/停止标记约束。
    - 验证：`member-agent/test/installer-lan-fixes.test.ts` 检查登录与重复触发及 Limited/IgnoreNew；真机分别杀 Node 和启动器计时。历史实测分别 10 秒与 3 分钟内，当前周期不能保证 3 分钟最坏时限。

12. **工作目录错误只说“目录不存在”，成员不知道改哪里。**
    - 根因：错误封装丢掉配置路径或误用了服务器 cwd。
    - 位置：`member-agent/src/executors/codex-support.ts` 的 resolveLocalCwd，消息带项目/默认目录、实际路径与修复建议。
    - 验证：`member-agent/test/codex-support.test.ts` 的 missing/file/permission/real destination 场景；派到不存在的专用测试目录，看板能定位对应映射，公开截图遮住真实路径。

13. **重装按回车却被要求重新填配置。**
    - 根因：沿用配置提示曾默认否。
    - 位置：uninstall.ps1 的 Confirm-Member 支持 DefaultYes；install.ps1 仅对“沿用现有配置”使用它。
    - 验证：`member-agent/test/installer-confirmation.test.ts`；真机回车沿用配置，不应连带把替换 Key、删除登录等确认变成默认是。

14. **CLI 显示成功，但智能体看不到 Paperclip 技能。**
    - 根因：非管理员 Windows 无符号链接权限，适配器技能链接失败未使工具任务失败。
    - 位置：codex-support.ts 的 materializeSkills 在 execute 前复制真实目录，已有链接替换成真实目录，更新时暂存与回滚。
    - 验证：`member-agent/test/codex-support.test.ts` 的 EPERM stub/复制失败闭锁；无开发者模式的非管理员真机能读技能并实际写回平台。

15. **任务结束还留 CLI/工具孤儿；取消被误报成功。**
    - 根因：只杀根 PID，父进程先退后 taskkill 无法遍历；或未经清理就发结果。
    - 位置：`member-agent/src/job-runner.ts`、`member-agent/src/process-tree.ts`、`member-agent/src/process-sampler.ts`；登记 PID、保留创建时间快照，结果前清理；失败用专属错误码。
    - 验证：`member-agent/test/process-tree.test.ts`、`member-agent/test/codex-lifecycle.test.ts`、`server/src/adapters/member-agent/cancellation.test.ts`；父先退再派生及 PID 复用不能误杀其他进程。采样是有限窗口，不承诺发现所有瞬时链路。

16. **团队模式跑通一次就当成无限制并发能力。**
    - 根因：把单次实测与未显示事件误当稳定产品契约，忽略同文件冲突和 token 消耗。
    - 位置：执行器与 UI 仍走 codex.ts、job-runner.ts、member_agent UI 原始 stdout；不会自动给 CLI 子智能体分配独立工作树或解决文件冲突。
    - 验证：按验收参考做一次任务内 3 个子智能体、分别拥有不同文件的并行工作，存时间线与文件清单。负责人历史观察为约 2 分钟重叠、文件互不覆盖；只测过不同文件，同文件冲突未测。exec --json 曾只显示 wait 类协作事件而不显示派生事件，不能以缺派生事件判定没并行。一次玩具任务约 99 万输入 token、其中约 78 万缓存命中，需保留用量证据并设置预算，不能把数字当复现指标。

17. **失败后智能体显示 error，被认为必须改回 ready。**
    - 根因：混淆代理在线/可接单状态与智能体上次运行的错误状态。
    - 位置：`server/src/services/heartbeat.ts` 的既有运行终态处理；连接与 runner 的空闲状态分别维护。
    - 验证：失败运行有清晰错误码，进程已清理，修复原因后授权重试能领任务；保留平台既有 error 行为，不在新执行器接入时顺便改语义。

18. **CodeBuddy 退出码为 0，任务实际上失败。**
    - 根因：退出码不可靠，终态 result.is_error 仍可能为 true，result 后还可能重复 init。
    - 位置：`member-agent/src/executors/codebuddy.ts` 的 normalizeCodeBuddyResult。
    - 验证：`member-agent/test/codebuddy-executor.test.ts` 覆盖零退出认证/模型/普通错误以及终态会话优先。

19. **更换 CODEBUDDY_CONFIG_DIR 却没有独立登录。**
    - 根因：凭据目录无法用配置目录隔离，固定落在用户目录扩展数据路径，与插件共用。
    - 位置：`member-agent/src/codebuddy-cli.ts` 的 hasCodeBuddyLogin 和登录环境构造；不得读取凭据内容来验证。
    - 验证：`member-agent/test/codebuddy-cli.test.ts` 检查存在性路径和 HOME/USERPROFILE 不覆盖；真机只比较凭据位置、存在性及配置隔离范围。

20. **复用层报 onSpawn 返回值没有 .catch。**
    - 根因：onSpawn 回调必须返回 Promise，复用层会对其调用 .catch；普通同步回调返回 undefined。
    - 位置：`member-agent/src/executors/codebuddy.ts` 的异步 onSpawn；登记 PID 后等待身份记录完成。
    - 验证：`member-agent/test/codebuddy-executor.test.ts` 显式 await onSpawn(...).catch(...)，再验真实取消零残留。

21. **PowerShell 5.1 Expand-Archive 在深目录解压失败。**
    - 根因：组合路径超过传统 Windows 260 字符；包内最长相对路径约 150 字符，深工作树容易越界。
    - 位置：`member-agent/scripts/build-installer.mjs` 的 archiveInstaller 读取源文件用扩展路径；解压端仍建议短目录，不能把压缩修复当作所有解压器已支持长路径。
    - 验证：`member-agent/test/codebuddy-installer.test.ts` 的超长路径打包测试；PS 5.1 真机在短目录解压并核对清单。
