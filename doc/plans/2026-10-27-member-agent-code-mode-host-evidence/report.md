# 成员端 code-mode host 缺失检查与真实工具调用回归

阶段：3 真实验收盲区修复（2026-10-27）。

## 结论与根因

已完成本轮要求。修复仅在 E:\workspace\paperclip-member-agent-dev 中，未编辑 D:\paperclip，未应用补丁，未连接专用服务器，未使用真实 Codex 账号。

原 inspectCodexInstallation 检查主程序、版本、登录文件存在性、运行包；没有检查主程序同目录的 codex-code-mode-host.exe。原执行器检查打包资产后直接加载并执行适配器，也没有该检查。原集成测试仅复制 codex.exe，模型固定回复文本且任务禁止工具调用，因此宿主缺失不影响文字回复，无法证明智能体具备实际工具能力。

现在自检新增独立“Codex 工具宿主”项；缺失、不可访问或路径为目录均失败，check 返回 2，打印从同一版本安装包同一目录复制两个 exe 的中文修复办法。执行器使用同一检查；缺失时返回 member_agent_runtime_missing，位于加载适配器、物化技能及实际启动 Codex 之前。

## 改动文件与行号

- member-agent/src/codex-cli.ts:7：宿主固定文件名、中文修复说明；:42：同目录普通文件和可读性检查；:69：独立检查结果；:89：并行执行所有独立检查。
- member-agent/src/main.ts:26：独立中文检查项；:30：失败时整体 check 不通过，沿现有配置错误路径退出 2。
- member-agent/src/executors/codex.ts:168：启动适配器前拒绝缺失宿主，错误码 member_agent_runtime_missing。
- member-agent/test/codex-cli.test.ts:47：更新全项独立检查用例；:60：宿主缺失、存在、同名目录三种实文件检查。
- member-agent/test/codex-check.test.ts:29：check 命令级退出码和中文提示两种情况（新增文件）。
- member-agent/test/codex-executor.test.ts:36：原执行器夹具补上明显的假宿主文件；:61：宿主缺失时不加载/启动适配器；:74：宿主存在时适配器执行成功。
- member-agent/test/codex-integration.test.ts:27：从同一 0.160.0 安装包同时缓存宿主；:54：临时文件随机内容；:74：假模型返回真实 custom_tool_call；:113：工具用例启用 code_mode / code_mode_host / code_mode_only；:162：工具执行结果回传模型的断言；:181：新增真实工具测试。
- doc/plans/2026-10-25-member-agent-phase3-evidence/acceptance.md:15：公共准备从同一安装包目录复制两个 exe；:90：B1 自检由四项改为五项。

补丁只含上述 8 个文件。不含运行时构建产物、二进制、依赖、服务端改动或此前修复。

## 新增测试及逐条结论

1. independently checks the sibling code-mode host when it is missing：通过。主程序存在时，宿主仍可独立失败。
2. independently checks the sibling code-mode host when it is file：通过。
3. independently checks the sibling code-mode host when it is directory：通过。不能把同名目录当成宿主。
4. check returns the correct exit code and independent diagnostic with host present=false：通过，check 返回 2、中文恢复说明齐全、不进入连接阶段。
5. check returns the correct exit code and independent diagnostic with host present=true：通过，check 返回 0 并进入后续连接流程。
6. fails before loading or running Codex when the sibling code-mode host is missing：通过，runtime_missing，适配器未被加载/运行。
7. runs the adapter when the sibling code-mode host exists：通过。
8. executes a real code-mode file read and returns its output to the loopback fake model without credentials：通过。

命令级单元测试只替换版本子进程与连接过程；文件存在性、目录判断、check 逻辑、退出码均执行真实实现。执行器单元测试用可观测的适配器边界记录是否被加载/运行。集成测试使用真实 Codex 0.160.0 和真实 codex-code-mode-host.exe，没有替换工具执行过程。当前 Windows 环境 212 项均执行通过，无跳过测试。

## 工具调用协议与有效性证据

本地固定版本实测确认 code mode 广告 custom 类型 exec 工具。假模型以 Responses SSE 返回 custom_tool_call，input 是 JavaScript，调用 tools.exec_command 执行：
Get-Content -LiteralPath './tool-input.txt'
命令只读取专属临时工作目录中的已知文件；明确使用 Windows PowerShell，不加载用户 shell 配置。

文件包含每次新生成的随机内容。该内容从未放入提示词或假模型返回的工具参数。Codex 必须启动工具宿主、执行命令，才可能把它回传。测试要求第二次模型请求携带 call_read_fixture 对应的 custom_tool_call_output，包含该随机内容及成功退出信息；工具结果必须恰好一条，模型请求必须恰好两次。每轮输出：
CODE_MODE_TOOL_ROUNDTRIP_OK fileNonceMatched=true toolOutputs=1 modelRequests=2

保留原文字回复集成测试，新增工具测试，每轮两个用例，断言没有放宽，没有增加重试、延长超时或跳过失败。缓存沿用已有 OS 临时目录做法，宿主来自主程序的同版本安装目录。所有模型请求只指向随机回环端口；Codex 使用专属临时 Home 和 requires_openai_auth=false。单元测试登录文件是明显的 FAKE 值，仅检查存在性；未读取真实 auth.json。

## 运行过的命令与完整输出（包含失败）

完整输出均在本目录，日志保留 pnpm 的既有配置警告。

工作目录 E:\workspace\paperclip-member-agent-dev\member-agent：

- pnpm exec vitest run --config vitest.config.ts --cache=false --reporter=verbose test/codex-cli.test.ts test/codex-check.test.ts test/codex-executor.test.ts
  - [unit-red.log](unit-red.log)：修复前 7 失败、25 通过。缺少宿主字段、缺少独立提示及执行器仍加载适配器的红测证据。
  - [unit-green.log](unit-green.log)：修复后 32 项通过，退出码 0。
- pnpm exec vitest run --config vitest.config.ts --cache=false --reporter=verbose test/codex-integration.test.ts
  - [integration-red-no-host.log](integration-red-no-host.log)：缓存仍只有主程序时，两项都因新增前置检查返回 member_agent_runtime_missing 而失败；诊断明确缺少宿主，没有模型输出。
  - [integration-with-host-attempt1.log](integration-with-host-attempt1.log)：加入同版本宿主后，两个测试通过，真实工具结果成功回传。
  - [integration-10-runner.log](integration-10-runner.log)：连续 10 轮的输出，10/10 通过、0 失败。每轮两个集成用例，累计 20 次用例通过；真实工具调用执行了 10 次。
  - [integration-10-summary.json](integration-10-summary.json)：每轮退出码、通过状态、真实工具往返标记。
  - integration-10/run-01.log 到 run-10.log：每轮完整输出。
  - run-integration-10.ps1：循环命令脚本；没有失败后重试。
- pnpm exec vitest run --config vitest.config.ts --cache=false --reporter=verbose
  - [member-full.log](member-full.log)：16 个文件、212 项全部通过，退出码 0。原有 204 项仍通过，新增 8 项。
- pnpm exec tsc --noEmit
  - [member-tsc-before.log](member-tsc-before.log)：改动前 0 错误、退出码 0。
  - [member-tsc-after.log](member-tsc-after.log)：改动后 0 错误、退出码 0，新增错误 0。
  - member-tsc-after-attempt1.log：较早一次同样通过的类型检查输出，保留。

工作目录 E:\workspace\paperclip-member-agent-dev\server：

- pnpm exec vitest run --config vitest.config.ts --cache=false --maxWorkers=1 --reporter=verbose src/adapters/member-agent/protocol.test.ts src/adapters/member-agent/cancellation.test.ts
  - [server-tests.log](server-tests.log)：2 个文件、49 项通过，退出码 0；仅使用测试自己的随机回环服务和临时数据。
- pnpm exec tsc --noEmit
  - [server-tsc-before.log](server-tsc-before.log)：改动前 0 错误、退出码 0。
  - [server-tsc-after.log](server-tsc-after.log)：改动后 0 错误、退出码 0，新增错误 0。

协议调查：
- node doc/plans/2026-10-27-member-agent-code-mode-host-evidence/probe-tool-schema.mjs
  - tool-schema-probe.log：首次直接 CLI 探针没有关闭 stdin，Codex 等待输入，被既定 30 秒探针超时终止。这是探针问题，未增加超时；修正为关闭 stdin。
  - tool-schema-probe-attempt2.log：默认工具广告实测成功。
  - tool-schema-code-mode.log：仅开启 code_mode 的广告实测成功。
  - tool-schema-host.log：开启 code_mode、code_mode_host、code_mode_only 后确认真实 exec 工具广告；退出码 0。
  - 上述日志只保存工具定义，不保存请求头或凭据。最终工具调用测试从当前配置启用所需开关，不依赖成员用户自己的配置。

## 补丁及 D 盘隔离验证

补丁：[code-mode-host.patch](code-mode-host.patch)。

相对路径以仓库根目录为基准（member-agent/... 与 doc/plans/...）。它的基线是 D:\paperclip 当前的目标文件，不是早期隔离副本 HEAD；因此只包含本轮差异。

新文件先在临时补丁索引 git add -N，随后 git diff --binary 生成。未提交任何仓库。补丁生成后的 git diff --check 退出码 0。

D 当前目标文件只读复制到本目录 apply-check/，初始化临时 Git 索引后执行：
git -C <E盘的apply-check临时副本> -c core.autocrlf=false apply --check -- <code-mode-host.patch>
退出码 0，无错误输出。[patch-check.log](patch-check.log) 记录完整命令位置、文件清单和 SHA-256。没有对 D 盘运行 git apply。

source-before.json 和 source-after.json 记录目标文件 SHA-256；d-status-before.txt、d-status-after.txt、d-isolation.json 记录 D 盘状态核对。新增 codex-check.test.ts 只在 E 盘存在。

## 验收项逐条结论

- check 的宿主独立检查和中文恢复说明：通过。
- 执行器在启动前阻止缺失宿主、错误码正确：通过。
- 集成夹具同时复制两个 exe：通过。
- 真实 Codex + 工具宿主 + 回环假模型，工具确实执行并回传：通过。
- 缺失/存在/同名目录单测，以及 check 退出码/执行器前置阻断：通过。
- 公共验收准备文档更新：完成。
- 成员端全套、连续 10 轮集成、服务端两份测试、两包类型检查：全部通过。
- 专用服务器 S2 重新验收：未执行，按任务限制未连接服务器和真实账号。

## 偏离本规格的地方

无。源码与验收文档只改 E 盘，补丁未应用到 D 盘。

## 遇到但未解决的问题

本轮检查按要求确认宿主在主程序同目录、是可访问文件；它不校验该二进制版本/签名或证明任意用户模型配置下的所有工具都能运行。真实工具执行已通过固定 0.160.0 的集成测试验证。

## 下一阶段需要负责人确认的事项

负责人审查补丁后决定何时同步/部署，并在真实成员电脑从同一 0.160.0 安装目录复制两个 exe，重新运行 check 与 S2，独立读回实际文件变更及工具日志。

