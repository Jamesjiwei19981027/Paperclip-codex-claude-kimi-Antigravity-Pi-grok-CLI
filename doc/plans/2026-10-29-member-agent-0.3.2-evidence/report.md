# 成员代理 0.3.2 第二轮修复证据

范围为任务 G。保留当前工作树上一轮未提交改动；本轮没有 git commit/stash/reset/checkout，没有改主目录，没有向目录联接 node_modules 安装依赖。复用适配器 parse.ts、execute.ts 与 HEAD 一致；CodeBuddy 启动器与 0.3.1 安装包逐字节一致，见 unchanged-boundaries.json。

## 本轮修改文件

1. `member-agent/src/executors/codebuddy.ts`：仅对 `claude_auth_required`，在 type=result、subtype=success、is_error!==true、exitCode===0、未超时且无信号时，删除 errorCode/errorMessage/errorFamily/errorMeta/retryNotBefore/loginUrl。其他错误码保持；条件不满足的 Claude 登录错误映射到成员 CodeBuddy 登录错误。现有空运行检测仍然生效。
2. `member-agent/src/job-runner.ts`：本机日志按 exitCode!==0、存在 errorCode 或 timedOut 判失败，显示错误码。`member-agent/test/job-runner.test.ts` 与 `test/fixtures/executor.ts` 覆盖零退出带码、超时、非零退出与正常成功。
3. `codebuddy.ts` 四种任务载体新增 Windows PowerShell 5.1 中文 JSON 的 UTF-8 字节与 Content-Type 提示；没有修改启动器的 20000 字符阈值。`test/codebuddy-executor.test.ts` 验证四载体，既有 launcher 测试覆盖长提示词和延迟 stdin。
4. 版本更新：`member-agent/package.json`、`package-lock.json`、`src/executors/echo.ts`；测试引用更新：`agent-version.test.ts`、`cli.test.ts`、`codebuddy-connection.test.ts`、`codebuddy-installer.test.ts`、`installer-errors.test.ts`；`member-agent/README.md` 与安装说明同步 0.3.2。
5. `test/codebuddy-executor.test.ts` 与 `test/fixtures/codebuddy-read-skill-success.jsonl`：完整回放、成功清错、失败登录映射和非登录错误保留。证据目录收集脚本、日志与清单；0.3.1 证据中本机用户目录、账户和主机标识同步脱敏。

## 回归原始输出

修复前 red-tests.txt：

```text
 Test Files  2 failed (2)
      Tests  12 failed | 31 passed (43)
   Start at  14:04:05
   Duration  6.78s (tests 97%, transform 2%, import 1%)
```

修复后 green-tests.txt（含启动器阈值回归）：

```text
 Test Files  3 passed (3)
      Tests  48 passed (48)
   Start at  14:04:47
   Duration  11.74s (tests 98%, transform 1%, import 1%)
```

member-agent-tests.txt（成员代理全量）：

```text
 Test Files  35 passed (35)
      Tests  501 passed (501)
   Start at  14:06:10
   Duration  534.04s (tests 100%)
```

`member-agent-tsc.txt`：`tsc exitCode=0`。UI 原始输出 ui-tests.txt：

```text
 Test Files  2 passed (2)
      Tests  11 passed (11)
   Start at  14:06:22
   Duration  5.52s (transform 61%, import 39%)
```

token-gates.txt：扫描 1209 文件，四项 CLEAN，All gates clean。逐条回归原始输出 regression-verbose.txt：2 文件 43/43 通过。技能文档检查 78 文件引用、3 相对链接、缺失 0；技能目录敏感格式扫描为空。只读复核无关键或重要问题，范围见 review.txt。

## 故障特征回放

fixture 包含 init、assistant 调 Read、user tool_result（当前 Paperclip 技能原句）、result success。测试断言该原句确实存在于当前技能中。合成 CLI 输出经过真实打包的 claude_local execute，再进入成员结果白名单和 normalize；不是只调用 parse 函数或伪造运行时返回值。真实复用运行时原样保留误判，证明没有改共享识别逻辑。

replay.txt 原始运行时输出：

```text
claude_local={"exitCode":0,"errorCode":"claude_auth_required","resultJson":{"type":"result","subtype":"success","is_error":false,"session_id":"fixture-session","result":"任务已完成","usage":{"input_tokens":100,"output_tokens":10}}}
回放断言通过：复用运行时保留原误判；成员归一化后 exitCode=0 且无 errorCode。
```

归一化完整结果保存在 replay.txt，其 exitCode=0、signal=null、timedOut=false，无 errorCode/errorFamily/errorMeta。失败终态与登录提示仍映射 member_agent_codebuddy_login_required；非零/空退出码、超时、信号、缺少成功 subtype、错误终态，以及 provider_quota/duplex_channel_lost/进程清理失败均有反例。

runner-log.txt：

```text
2026-10-29T06:16:36.679Z INFO 任务结束 fixture-log：失败（member_agent_codebuddy_login_required）
{"v":1,"type":"job.result","jobId":"fixture-log","exitCode":0,"signal":null,"timedOut":false,"errorCode":"member_agent_codebuddy_login_required"}
```

utf8-api.txt（本地 HTTP 收到的真实 PS 5.1 请求）：

```text
PowerShell=5.1.26100.9711
exitCode=0
received=[{"contentType":"application/json; charset=utf-8","body":{"title":"中文标题与任务完成评论"}}]
UTF-8 字节请求保留中文：通过
```

两次收集进度输出时的宿主 CLIXML 解析错误保留为 utf8-api-attempt*.txt；验收脚本关闭进度后成功。仅为收集脚本修正，未改产品逻辑。

## 安装包

先单独 build-runtime，再按 commands.md 的上一轮命令顺序构建两个变体。使用上一轮 Node 24.18.0 官方 ZIP 缓存，SHA-256 为 `0ae68406b42d7725661da979b1403ec9926da205c6770827f33aac9d8f26e821`，仍由构建器核对 SHASUMS 和固定二进制。runtime adapterPackageVersion=0.3.1 是既有适配器版本，成员代理 agentVersion=0.3.2。

- `member-agent/dist-installer/PaperclipMemberAgent-0.3.2-codebuddy.zip`：128848624 字节，SHA-256 `e48ef79c44d5f8ea7e671aee244bfd0e36bff91c1f69de341218be44f1fc3df1`。
- `member-agent/dist-installer/PaperclipMemberAgent-0.3.2.zip`：173268116 字节，SHA-256 `df3b07c94588ed5b9dd9a651283e43dd0cab328d8f98bbf6c812e854e31efd9e`。

完整绝对路径见 packages.json。两个包的 package、echo 版本与 job-runner 源码均与工作树一致；CodeBuddy 包执行器和启动器也逐字节一致，见 package-source-checks.json。

## PowerShell 5.1 短路径解压与自检

check-packages.mjs 使用与上一轮相同的验收方式：PS 5.1 Expand-Archive 解压到临时短目录，构造版本目录与包清单，再由原 start.ps1 -Mode check -TestMode 调用包内真实 Node/main.ts。TestMode 替换 Key 与计划任务边界；执行器版本、包清单、runtime 和登录存在性检查实际执行。连接是随机本地 WebSocket 握手。

package-checks.txt 的原始输出节选（仅脱敏）：

```text
PowerShell=5.1.26100.9711
codebuddy: extract=%USERPROFILE%\AppData\Local\Temp\pf032-vCS7Gy\zip; expand_ms=32803
hello={"agentVersion":"0.3.2","executor":"codebuddy","executorVersion":"2.169.0"}
2026-10-29T06:18:13.848Z INFO 通过：CodeBuddy 版本 2.169.0，要求 2.169.0
2026-10-29T06:18:13.849Z INFO 通过：共享登录凭据存在（仅检查存在性）
2026-10-29T06:18:13.849Z INFO 通过：安装包清单完整
2026-10-29T06:18:13.850Z INFO 通过：运行时完整
codebuddy: start.ps1 -Mode check exitCode=0; check_ms=2310
PowerShell=5.1.26100.9711
codex: extract=%USERPROFILE%\AppData\Local\Temp\pf032-3dVVe9\zip; expand_ms=4375
2026-10-29T06:18:22.672Z INFO 通过：Codex 可执行文件存在
2026-10-29T06:18:22.673Z INFO 通过：Codex 工具宿主 codex-code-mode-host.exe 存在
2026-10-29T06:18:22.673Z INFO 通过：Codex 版本 0.160.0
2026-10-29T06:18:22.673Z ERROR 失败：Codex 登录凭据不存在，请先运行 login
2026-10-29T06:18:22.674Z INFO 通过：运行时包完整；如需重建，请运行 build-runtime
codex: start.ps1 -Mode check exitCode=1; check_ms=1248
```

验收脚本整体退出码 0 不代表 Codex 自检通过：它明确允许临时目录未登录的失败，并记录退出码 1。CodeBuddy 自检通过（2.310 秒）；Codex 已执行自检（1.248 秒），完整已登录自检未完成。原始日志保留 PS 的进度 CLIXML 和权限告警，不删改成全绿。

## 证据脱敏与最后检查

两轮证据中的本机用户目录统一替换为 `%USERPROFILE%`，账户、主机标识也已替换为占位符。sanitize-evidence.py 重新解析六个 JSON/JSONL 文件通过，见 sanitization.txt；最终指定敏感词 rg 的 stdout 为空，退出码 1，见 sensitive-scan.txt。`git diff --check` 退出码 0。

## 验证边界与未完成项

- 没有重新向远端真机派发任务；本轮回放是合成 CLI 输出经过真实运行时，不代表远端闭环复测。
- 包自检使用隔离临时安装布局、测试 Key 边界与本地 WebSocket 握手，不覆盖成员现有安装、不注册计划任务，不代表生产平台连接。
- Codex 使用全新临时专属目录，没有 auth.json，不复制个人凭据。完整已登录自检需有相应成员登录条件。
- 未运行仓库全量 typecheck/test:run/build，也未创建 PR；本轮提供成员代理全量、定向 UI、token gates 与实际安装包验证，不宣称仓库 PR-ready。
- 已尝试仓库 artifact helper，因缺少 jq 失败；当前会话所需 Paperclip API、公司、任务和运行环境变量也均缺失，无法上传或登记 work product。见 artifact-upload.txt。两个包目前仅在工作树，未声称已上传。

## 审核修复

任务 H：版本保持 0.3.2。本节记录审核修复后的新包；前面安装包一节的大小、哈希和验证结果属于上一轮历史记录。

### 修复内容与测试

仅修改 `member-agent/src/executors/codebuddy.ts` 与对应 `test/codebuddy-executor.test.ts` 的产品代码和测试。四个 Markdown 字段只有在原值为非空字符串（排除纯空白）时才前置指引。缺失字段保持不存在，空值和非字符串原样保留。共享 REST 指引函数也会补齐字段，因此改为在副本上生成指引，只回写原来有效的字段；没有修改共享函数及 Codex 行为。没有执行 git commit/stash/reset/checkout，没有修改主目录，没有向工作树或共享 node_modules 安装依赖。打包器沿用上一轮独立临时目录准备 CLI 的方式。

新增测试名称：

- `prepends UTF-8 guidance to all four existing non-empty Markdown carriers`
- `prepends UTF-8 guidance only to the existing task Markdown without creating absent carriers or undefined text`
- `preserves empty or non-string Markdown carriers unchanged: %j`（7 组参数：空字符串、纯空白、null、undefined、0、false、对象）

第一项验证四字段齐全时均前置 UTF-8 指引且保留各自正文；第二项验证仅主字段存在时其他三个属性仍不存在，整个上下文序列化后不含字面量 undefined。既有 CLI 配置测试改为显式提供四个字段，避免继续依赖错误的补齐行为。

修复前先运行新增测试，`review-fix-red.txt` 原始输出节选：

```text
 Test Files  1 failed (1)
      Tests  8 failed | 28 passed (36)
   Start at  14:24:10
   Duration  4.32s (tests 96%, transform 3%, import 1%)
```

修复后同一文件 `review-fix-green.txt`：

```text
 Test Files  1 passed (1)
      Tests  36 passed (36)
   Start at  14:24:32
   Duration  4.16s (tests 96%, transform 3%, import 1%)
```

成员代理目录运行 `node ../node_modules/vitest/vitest.mjs run --cache=false`，`review-fix-member-agent-tests.txt` 原始输出：

```text
 RUN  v5.0.3 D:/paperclip/.claude/worktrees/codebuddy-executor-6332a5/member-agent

 Test Files  35 passed (35)
      Tests  510 passed (510)
   Start at  14:25:01
   Duration  467.30s (tests 100%)
```

Vitest 进程退出码 0。仓库根目录运行 `node node_modules/typescript/bin/tsc -p member-agent/tsconfig.json`，编译器无诊断，`review-fix-member-agent-tsc.txt` 原始退出记录：

```text
tsc exitCode=0
```

### 重打包命令与新包

先单独执行 build-runtime，再按上一轮顺序执行两个安装包命令（全部成功，退出码 0）：

```text
node member-agent/scripts/build-runtime.mjs
node member-agent/scripts/build-installer.mjs --executor codebuddy --node-zip E:/workspace/paperclip-member-agent-dev/doc/plans/2026-10-27-member-agent-phase6-evidence/downloads/node-v24.18.0-win-x64.zip
node member-agent/scripts/build-installer.mjs --node-zip E:/workspace/paperclip-member-agent-dev/doc/plans/2026-10-27-member-agent-phase6-evidence/downloads/node-v24.18.0-win-x64.zip
```

复用同一份官方 Node ZIP 缓存，构建器原始校验输出：

```text
[installer-build] Node 官方 ZIP SHA-256：0ae68406b42d7725661da979b1403ec9926da205c6770827f33aac9d8f26e821
```

构建日志分别保存为 `review-fix-build-runtime.txt`、`review-fix-build-codebuddy.txt`、`review-fix-build-codex.txt`。由 `review-fix-verify-packages.py` 独立读取最终 ZIP，逐文件核对外层清单大小及哈希，核对 ZIP 路径、成员版本和工作树源码；CodeBuddy 包专门核对本次修复的执行器源码。`review-fix-package-verification.txt` 原始输出如下，完整机器可读记录另见 `review-fix-packages.json`：

```text
PaperclipMemberAgent-0.3.2-codebuddy.zip: agentVersion=0.3.2; manifestFiles=10461; 清单、ZIP 路径、版本与源码校验通过
{"path": "D:/paperclip/.claude/worktrees/codebuddy-executor-6332a5/member-agent/dist-installer/PaperclipMemberAgent-0.3.2-codebuddy.zip", "bytes": 128848724, "sha256": "6959fd61108e2ee370490ad7c49de32d3879c0e0a410b1c8eb4f330735241980"}
PaperclipMemberAgent-0.3.2.zip: agentVersion=0.3.2; manifestFiles=65; 清单、ZIP 路径、版本与源码校验通过
{"path": "D:/paperclip/.claude/worktrees/codebuddy-executor-6332a5/member-agent/dist-installer/PaperclipMemberAgent-0.3.2.zip", "bytes": 173268117, "sha256": "74ad1009f72f592c74f7ae2bf7cb1a0fa2562ec1f8a3784bb43c03deaff8b60b"}
```

### 解压自检、交付与边界

沿用 `node doc/plans/2026-10-29-member-agent-0.3.2-evidence/check-packages.mjs`，使用 PS 5.1 短路径解压和隔离临时安装布局；没有覆盖成员现有安装，没有注册计划任务，没有复制个人凭据。`review-fix-package-checks.txt` 原始输出节选：

```text
codebuddy: start.ps1 -Mode check exitCode=0; check_ms=2148
PowerShell=5.1.26100.9711
codex: start.ps1 -Mode check exitCode=1; check_ms=1229
Codex 使用全新专属目录，无 auth.json；预期自检因未登录失败，未复制真实凭据。
```

CodeBuddy 自检通过；Codex 二进制、工具宿主、固定版本和 runtime 检查通过，但临时目录没有登录凭据，完整自检退出码 1。脚本整体退出码 0 不代表 Codex 已登录自检通过。本次没有远端真机复测，没有运行仓库全量 typecheck/test:run/build，不宣称仓库 PR-ready。

按仓库生成物流程再次尝试上传 CodeBuddy 新包，`review-fix-artifact-upload.txt` 原始输出为 `Missing required command: jq`，退出码 1。Paperclip API、Key、公司、任务、运行环境变量均未提供，无法上传或登记 artifact/workspace_file work product；两个包目前仅在上述工作树路径，未声称上传成功。

本次日志使用 `review-fix-sanitize.py` 去除本机账户、用户目录和主机标识，保留其余测试与构建输出。最终对本节、整份报告及本次日志执行敏感标识扫描，结果通过；`git diff --check` 退出码 0。

## 撤回审核修复

任务 H 的负责人审核结论前提有误。`shared-runtime.ts` 的 `addPaperclipRestGuidance(localized.context, home)` 原本就会把四个任务载体键补成字符串，并为缺失载体提供 REST 操作说明和任务正文兜底。任务 H 改为在副本上生成指引、只回写原本存在的字符串键，会使缺失载体丢失这些内容，因此本轮撤回该回退。

### 实现与回归断言

`member-agent/src/executors/codebuddy.ts` 已恢复为先直接调用 `addPaperclipRestGuidance(localized.context, home)`，再对四个载体统一前置 Windows PowerShell 5.1 UTF-8 指引。前置步骤保留 `typeof text === "string"` 防御；此时四个键均由共享函数补成字符串。

`member-agent/test/codebuddy-executor.test.ts` 已删除“不创建缺失载体”断言，改为只提供 `paperclipTaskMarkdown: "do work"` 时断言四个载体均存在、均以 UTF-8 指引开头、均包含 REST 说明、`do work` 任务正文且没有 `undefined`。空字符串、空白、null、undefined、数字、布尔值和对象输入也验证为补齐后的字符串指引。

修复前新增回归测试原始输出：

```text
 Test Files  1 failed (1)
      Tests  8 failed | 28 passed (36)
```

修复后成员代理全量 Vitest 原始输出：

```text
 RUN  v5.0.3 D:/paperclip/.claude/worktrees/codebuddy-executor-6332a5/member-agent

 Test Files  35 passed (35)
      Tests  510 passed (510)
   Start at  14:43:10
   Duration  513.92s (tests 99%)

vitest exitCode=0
```

成员代理 tsc 原始输出：

```text
tsc exitCode=0
```

### 构建与安装包

按要求先单独执行 `node member-agent/scripts/build-runtime.mjs`，随后执行两个安装包构建命令；三次构建均退出码 0。runtime 原始输出：

```text
[runtime-build] 构建完成：D:\paperclip\.claude\worktrees\codebuddy-executor-6332a5\member-agent\runtime
[runtime-build] 适配器版本：0.3.1；esbuild 0.28.2；目标 node24
build-runtime exitCode=0
```

两个新包如下：

```text
D:\paperclip\.claude\worktrees\codebuddy-executor-6332a5\member-agent\dist-installer\PaperclipMemberAgent-0.3.2-codebuddy.zip
bytes=128848654
sha256=794f0a994149e688fbea015d4645bf69f66d8650c390e71b216565b15037d58d

D:\paperclip\.claude\worktrees\codebuddy-executor-6332a5\member-agent\dist-installer\PaperclipMemberAgent-0.3.2.zip
bytes=173268111
sha256=29eb547f46f4f00644f075ea90b763b5d16068516b208001e1b8b4cc4985f233
```

独立 ZIP 清单、版本、源码和路径校验原始输出：

```text
PaperclipMemberAgent-0.3.2-codebuddy.zip: agentVersion=0.3.2; manifestFiles=10461; 清单、ZIP 路径、版本与源码校验通过
{"path": "D:/paperclip/.claude/worktrees/codebuddy-executor-6332a5/member-agent/dist-installer/PaperclipMemberAgent-0.3.2-codebuddy.zip", "bytes": 128848654, "sha256": "794f0a994149e688fbea015d4645bf69f66d8650c390e71b216565b15037d58d"}
PaperclipMemberAgent-0.3.2.zip: agentVersion=0.3.2; manifestFiles=65; 清单、ZIP 路径、版本与源码校验通过
{"path": "D:/paperclip/.claude/worktrees/codebuddy-executor-6332a5/member-agent/dist-installer/PaperclipMemberAgent-0.3.2.zip", "bytes": 173268111, "sha256": "29eb547f46f4f00644f075ea90b763b5d16068516b208001e1b8b4cc4985f233"}
package-verification exitCode=0
```

解压与安装自检原始输出：

```text
codebuddy: start.ps1 -Mode check exitCode=0; check_ms=3464
codex: start.ps1 -Mode check exitCode=1; check_ms=1360
Codex 使用全新专属目录，无 auth.json；预期自检因未登录失败，未复制真实凭据。
package-checks exitCode=0
```

CodeBuddy 自检通过；Codex 的二进制、工具宿主、版本和 runtime 检查通过，隔离临时目录没有登录凭据，所以按预期以退出码 1 结束。`git` 仍未执行 commit、stash、reset 或 checkout；未修改主目录，未安装 node_modules。

本节与新增日志已执行脱敏扫描，未包含本机账户或主机标识。artifact 上传辅助脚本因缺少 `jq` 退出码 1，且当前会话未提供 Paperclip API 环境变量，两个安装包仅保留在上述工作树路径。
