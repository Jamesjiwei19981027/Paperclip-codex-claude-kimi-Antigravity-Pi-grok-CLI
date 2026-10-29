# 任务 F：成员代理 0.3.1 验证记录

日期：2026-10-29。仅改指定工作树，未执行 git commit/stash/reset/checkout，未改主目录或向共享 node_modules 安装依赖。保留此前未提交改动。

## 启动器先收齐 stdin

member-agent/src/executors/codebuddy-launcher.ts；member-agent/test/codebuddy-launcher.test.ts。直到 stdin end 才 spawn；Buffer 拼接后一次 end(prefix + prompt)，保留信号转发和退出码。5 秒延迟测试还覆盖跨 UTF-8 字节分块、长系统前缀与子进程退出码 7。

## 空运行判失败

member-agent/src/executors/codebuddy.ts；member-agent/test/codebuddy-executor.test.ts。终态为空、用量 0/0、无 assistant 的零退出运行转换为 member_agent_codebuddy_empty_run；逐行观察原始 stdout（含分块、CRLF、末行无换行）。正常短回复和 assistant 消息不误判。未修改 adapter-utils 写入时机或 onSpawn await。

## Windows 技能物化

packages/adapters/claude-local/src/server/prompt-cache.ts；同目录 prompt-cache.test.ts。仅此适配器 Windows 目录直接用绝对路径 junction；EPERM/EACCES/ENOTSUP 时复制，其他平台保留 symlink；新增实际读取 SKILL.md 的两项测试。

## 安装器保留失败原因

member-agent/installer/install.ps1；member-agent/test/installer-errors.test.ts。外层先保存 Exception.Message，收尾后输出；清单内层保留原因，未列入清单的文件附相对路径。审阅 install.ps1/uninstall.ps1 的 throw 文本，未插入 Key 值；两种 PowerShell 使用假 Key 的端到端测试均确认无泄漏。

## 安装说明

member-agent/installer/README-成员安装说明.md。明确空文件夹解压，原压缩包不得放进解压目录，并说明启动自检的新校验范围。member-agent/README.md 同步版本与校验说明。

## 减少重复哈希

member-agent/src/codebuddy-cli.ts；member-agent/test/codebuddy-cli.test.ts。PACKAGE-MANIFEST.json 模式仍核对每个文件存在、类型与大小、检查 CodeBuddy 未列入清单文件；仅哈希 CodeBuddy 入口、顶层 package.json/package-lock.json 和 CodeBuddy 包 package.json。解压目录 MANIFEST.json 保留全量哈希；安装器也保留全量 SHA-256。测试证明普通文件同尺寸变更跳过哈希，关键文件同尺寸变更仍失败，缺文件或改大小仍失败。

## 升级与打包

member-agent/package.json、package-lock.json、src/executors/echo.ts；test/agent-version.test.ts、cli.test.ts、codebuddy-connection.test.ts、codebuddy-installer.test.ts；README 与安装说明均为 0.3.1。两个变体先 build-runtime 再打包；来源仍为已缓存 Node 24.18.0 ZIP 及原固定 CLI 来源。无依赖安装写入任何联接 node_modules。

## 自动测试原始摘要

命令：在 member-agent 目录执行 `node ..\node_modules\vitest\vitest.mjs run --cache=false`。

```text
Test Files  35 passed (35)
      Tests  484 passed (484)
   Start at  13:20:31
   Duration  550.65s (tests 100%)
```

member-agent tsc：`node node_modules/typescript/bin/tsc -p member-agent/tsconfig.json`，退出码 0。

定向新增/关联回归（4 文件）：

```text
Test Files  4 passed (4)
      Tests  27 passed (27)
   Start at  13:29:02
   Duration  9.22s (tests 96%, transform 2%, import 1%)
```

Windows junction/复制回退：1 文件 2/2 通过；UI member-agent：2 文件 11/11 通过。原始输出见 junction-tests.txt 和 ui-tests.txt。token gates 扫描 1209 文件，四项 CLEAN。git diff --check 通过。技能 verify-docs.py 通过（78 个文件引用、缺失 0），对技能目录敏感格式扫描未命中；未修改技能目录。

## Claude 回归与原实现对照

共运行适配器包与服务端 5 个 claude_local/技能测试文件：

```text
 Test Files  9 failed | 17 passed | 1 skipped (27)
      Tests  76 failed | 332 passed | 1 skipped (409)
```

服务端单独结果：

```text
 Test Files  3 failed | 2 passed (5)
      Tests  34 failed | 22 passed (56)
```

失败主要为现有 Unix shebang、PATH/远端 shell 夹具无法在 Windows 正常运行（例如 probe-env 测试只创建无扩展名的 `#!/bin/sh` 工具）。没有为变绿修改不相关产品逻辑。使用独立 Vitest 配置在 transform 中加载 `git show HEAD:.../prompt-cache.ts` 的原始实现，未覆盖工作树文件；同样得到 76 个失败且名称完全一致（407 项，缺少本次新加的 2 项通过）。baseline-comparison.json 验证 only_modified/only_baseline 都为空。没有宣称 Claude 套件全绿。配置与日志均在此目录。

## 真 CodeBuddy 延迟输入冒烟

命令：`node doc/plans/2026-10-29-member-agent-0.3.1-evidence/smoke-delayed-stdin.mjs`。使用最终安装包中的 Node、启动器及 CodeBuddy；独立临时 CODEBUDDY_CONFIG_DIR，使用账号默认模型和本机既有共享登录，仅任务进程使用代理。原始终态输出：

```text
stdin_delay_ms=5043
exitCode=0; elapsed_ms=12639
{"type":"result","subtype":"success","is_error":false,"result":"你好","uuid":"01a18623-c8b2-7638-ba22-d38a6ba49dd2","session_id":"01a18623-b443-7229-9acf-31b06763e79d","duration_ms":3399,"duration_api_ms":3396,"num_turns":3,"total_cost_usd":0,"usage":{"input_tokens":24238,"output_tokens":30,"cache_creation_input_tokens":22830,"cache_read_input_tokens":1408,"cache_creation":null,"server_tool_use":null,"service_tier":null},"permission_denials":[],"modelUsage":{"hy4-preview":{"inputTokens":0,"outputTokens":30,"cacheReadInputTokens":1408,"cacheCreationInputTokens":22830,"contextWindow":960000,"maxOutputTokens":64000}},"_requestId":"01a18623ba2972d1a907a1fe84e8253b","_meta":{"traceparent":"00-59d758333abb916c07bb76c917fa1c55-9535b2ced504839d-01","baggage":"codebuddy.session_id=01a18623-b443-7229-9acf-31b06763e79d,codebuddy.conversation_request_id=01a18623ba2972d1a907a1fe84e8253b"},"__timestamp":"2026-10-29T05:30:54.518Z"}
```

完整 stdout 与 stderr 分别见 smoke-stdout.jsonl、smoke-stderr.txt。

## 安装器失败诊断原始输出

```text
powershell.exe: exitCode=1
失败原因：安装包已损坏或被修改，请重新获取。原因：发现未列入清单的文件：extra.zip
pwsh.exe: exitCode=1
失败原因：安装包已损坏或被修改，请重新获取。原因：发现未列入清单的文件：extra.zip
```

## 安装包

- `D:\paperclip\.claude\worktrees\codebuddy-executor-6332a5\member-agent\dist-installer\PaperclipMemberAgent-0.3.1-codebuddy.zip`
  - 字节数：128848147
  - SHA-256：`60274a72c6b05e4d259314c75749a062cd267ba361cf532deb97ea873f201e10`
- `D:\paperclip\.claude\worktrees\codebuddy-executor-6332a5\member-agent\dist-installer\PaperclipMemberAgent-0.3.1.zip`
  - 字节数：173268077
  - SHA-256：`e98e02498b7fe26b21ae1566bdd778c39e3a16c174783102d622a80446d306d2`

最终 CodeBuddy 包中启动器、执行器、自检、echo 版本文件、安装器和安装说明与工作树字节一致。构建命令及输出见 build-codebuddy-final.txt、build-codex.txt。

## PowerShell 5.1 解压与自检

`check-packages.mjs` 用 PowerShell 5.1 的 Expand-Archive 解压至临时短目录，随后构造与安装器相同的 versions/版本布局和 PACKAGE-MANIFEST.json，通过原 start.ps1 -Mode check -TestMode 调用包内真实 Node/main.ts。TestMode 只替换 Key 与计划任务边界；CodeBuddy 文件、版本、runtime、共享登录检查真实执行，连接使用本地 WebSocket 假握手服务，不是远端生产平台。未执行真实计划任务注册或覆盖用户安装。

原始输出节选（完整见 package-checks.txt）：

```text
PowerShell=5.1.26100.9711
codebuddy: extract=%USERPROFILE%\AppData\Local\Temp\pf031-rRi7Oz\zip; expand_ms=37498
2026-10-29T05:31:11.475Z INFO 通过：CodeBuddy 版本 2.169.0，要求 2.169.0
2026-10-29T05:31:11.476Z INFO 通过：共享登录凭据存在（仅检查存在性）
2026-10-29T05:31:11.476Z INFO 通过：安装包清单完整
2026-10-29T05:31:11.477Z INFO 通过：运行时完整
codebuddy: start.ps1 -Mode check exitCode=0; check_ms=2290
PowerShell=5.1.26100.9711
codex: extract=%USERPROFILE%\AppData\Local\Temp\pf031-qtUdOm\zip; expand_ms=4680
2026-10-29T05:31:20.803Z INFO 通过：Codex 可执行文件存在
2026-10-29T05:31:20.804Z INFO 通过：Codex 工具宿主 codex-code-mode-host.exe 存在
2026-10-29T05:31:20.805Z INFO 通过：Codex 版本 0.160.0
2026-10-29T05:31:20.805Z ERROR 失败：Codex 登录凭据不存在，请先运行 login
2026-10-29T05:31:20.806Z INFO 通过：运行时包完整；如需重建，请运行 build-runtime
codex: start.ps1 -Mode check exitCode=1; check_ms=1293
Codex 使用全新专属目录，无 auth.json；预期自检因未登录失败，未复制真实凭据。
```

第一次解压验证脚本的进度 CLIXML 超过 execFileSync 缓冲；关闭解压进度后成功。其后一次收尾曾因 node.exe 被短暂占用而 EBUSY；保留 package-checks-attempt1.txt，添加仅验收脚本的删除重试后再次运行退出 0。最终 Codex 自检确实运行，但全新 codexHome 无登录而失败；未复制个人凭据伪造成功。

## 未完成或限制

- Claude 全套在此 Windows 环境未全绿；原实现相同 76 项失败，未观察到本次新增失败。
- Codex 的已登录完整自检未完成：本次专属临时目录没有 auth.json；包内二进制、工具宿主、版本和 runtime 检查已通过。
- 本次未运行仓库范围 typecheck/test:run/build，也未创建 PR；按任务范围运行成员代理全量与相关测试，不将结果称为仓库 PR-ready。
- 未代替负责人重做远端真机派任务闭环；本轮证明的是本机真实 CLI 的延迟输入与最终安装包自检。
- 交付文件仍在工作树：按仓库流程尝试 artifact helper，返回 `Missing required command: jq`；同时当前会话全部 PAPERCLIP_API_URL/API_KEY/COMPANY_ID/TASK_ID/RUN_ID 缺失，无法上传或创建 work product。未声称已附加到 Paperclip。
