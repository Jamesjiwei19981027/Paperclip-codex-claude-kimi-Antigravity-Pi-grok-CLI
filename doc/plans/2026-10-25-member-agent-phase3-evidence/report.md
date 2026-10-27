# 阶段 3：成员代理接入 Codex

日期：2026-10-25（Asia/Shanghai）

阶段：3（隔离副本实现、自动化验收及负责人真实账号验收）。

## 当前验收状态（2026-10-27）

以下真实验收结果由负责人独立从服务器读回或在成员电脑本机核对后提供，本次仅据此更新文档，没有连接专用服务器或读取登录凭据。运行编号按负责人提供的前缀记录，不补全未知部分。时间均为北京时间。

| 验收项 | 状态 | 核对事实 |
|---|---|---|
| A1–A8（阶段 2） | 通过 | 沿用已完成的阶段 2 验收记录。 |
| B1 | 通过 | check 五项全过：可执行文件、工具宿主、版本 0.160.0、登录、运行包。 |
| B2 | 通过 | BOS-6，负责人已独立读回。 |
| B3 | 通过 | BOS-8，负责人已读回 `executionCancellation.state=acknowledged`；历史记录见下文。 |
| B4 | 通过 | `codex-home\skills\paperclip` 是真实目录，内容与运行包一致。 |
| S1 | 通过 | 使用独立 codex-home 登录；仅检查 `auth.json` 存在。 |
| S2 | 通过 | BOS-10，运行 `0d41add0`：README 追加 `S2-MARKER-KX8BX9W0`，`git --version` 输出正确；智能体评论、建确认卡后转为 `in_review`，只运行 1 次。首次 BOS-9 因成员电脑缺少 `codex-code-mode-host.exe` 失败，该问题已修复。 |
| S3 | 通过 | 活动日志 `issue.thread_interaction_created`、`issue.updated`、`issue.comment_added` 的执行者均为该智能体，runId 为 `0d41add0`。 |
| S4 | 通过 | BOS-15，运行 `f1db0c71`：取消前有 6 个进程（codex.exe、codex-code-mode-host.exe、两层 pwsh.exe、两个 conhost.exe），取消后全部退出；`S4-SHOULD-NOT-EXIST.txt` 未创建。服务器约 20 秒后记录 `executionCancellation` 为 `acknowledged`、proof 为 `member_agent_stop_result`，取消接口返回 200。 |
| S5 | 通过 | BOS-16，临时 `maxRunSec=60`，运行 `dd9d7692` 约 63 秒后为 `timed_out`、`errorCode=timeout`；本机 codex.exe 已退出，`S5-SHOULD-NOT-EXIST.txt` 未创建。之后 `maxRunSec` 已恢复 3600。本次超时发生在 Codex 尚未开始执行命令时；截断正在执行的命令由 S4 覆盖。 |
| S6 | 通过 | BOS-10 第二次运行 `71c14071` 的 `sessionIdBefore` 等于上次 `sessionIdAfter`（`01a17b36…`），usage 记录 `sessionReused`；智能体未重读文件即答出上次标记。 |
| S7（复验） | 通过 | BOS-13（项目一）、BOS-14（项目二）同时派发后依次执行：前者 12:24:15 结束，后者 12:24:16 开始，无 `member_agent_busy`，两任务均由智能体自行改为 `done`。`S7R-PROJECT-ONE.txt` 只在 `E:\workspace\member-test-project`，`S7R-PROJECT-TWO.txt` 只在 `E:\workspace\member-test-project-2`。首次 S7 的 BOS-11、BOS-12 暴露操作方式提示与并发派发两个缺陷，已修复并部署。 |
| S8 | 通过 | BOS-10 第二次运行 `71c14071` 的命令输出为 `PAPERCLIP_AGENT_KEY absent`。 |

下文保留实现及各轮同步的历史记录；其中当时“未执行”的表述不表示当前验收状态。

## 同步后验收状态（2026-10-26，历史记录）

- E→D 共同步 88 个差异文件；D 盘较新的总规格另反向复制到 E 盘。复制后 89 个纳入清单的路径（含总规格）逐文件哈希全部一致。之后按要求只更新了 D 盘本报告，因此当时复核为 88 项一致、1 项预期差异（本报告），没有其他差异。
- D 盘独有的 65 个文件全部保留，均在 `doc/` 下；备份清单中的 13 项 SHA-256 均已验证。
- 阶段 2 的 A1–A8：通过。
- B2（BOS-6）：通过，负责人 Claude 已从看板读回。
- B3（BOS-8）：通过，Claude 已读回 `executionCancellation.state=acknowledged`。
- 截至本次同步时，B1、B4、S1–S8 未执行；S7 当时只有程序层测试通过。2026-10-27 的完成结果见当前验收状态表。
- 同步后的本机回归：member-agent 全套 14 个文件、202 项通过；server 成员代理协议、取消、注册表、live-events 测试共 4 个文件、93 项通过；server 与 member-agent `tsc --noEmit` 均退出 0。首次 member-agent 全套运行中 Codex 集成用例失败，单独重跑通过，随后全套重跑 202 项通过。完整日志保存在 `E:\AI_Data\backups\paperclip\2026-10-26-before-sync-phase3-b3\verification\`。
- `git status --porcelain` 从 56 行变为 57 行，只新增本次同步的 `doc/plans/2026-10-26-member-agent-b3-fix-evidence/` 未跟踪目录，没有状态项被删除。
- 按负责人要求，本次同步未检查本机 3100 health，未启动或重启服务。

## 改动文件

工作副本为 `E:\workspace\paperclip-member-agent-dev`；补丁只包含 `member-agent/` 下 22 个文件（8 个已有文件修改、14 个新增文件）。逐文件职责如下：

- `member-agent/.gitignore`：排除本机构建的 `runtime/`。
- `member-agent/README.md`：补充 Codex 配置、打包、登录和执行说明。
- `member-agent/scripts/build-runtime.mjs`：将 Codex 适配器与技能打包到受路径断言保护的 runtime 目录并生成 manifest。
- `member-agent/src/codex-cli.ts`：Codex 版本读取、登录和独立安装检查。
- `member-agent/src/config.ts`：校验 Codex 可执行文件、专属 home、runtime 路径和执行器配置。
- `member-agent/src/connection.ts`：发送真实 Codex 版本并处理服务器固定版本的兼容窗口。
- `member-agent/src/executor-worker.ts`：向执行器转发 meta、usage 和子进程登记钩子。
- `member-agent/src/executors/codex-support.ts`：本机目录映射、服务器路径重写、端点重设和技能实体化。
- `member-agent/src/executors/codex.ts`：隔离环境并调用打包适配器，映射回调与结果。
- `member-agent/src/executors/types.ts`：扩展执行器钩子类型。
- `member-agent/src/job-runner.ts`：登记并清理进程树，验证并转发 meta/usage。
- `member-agent/src/main.ts`：实现 login/check、真实版本上报及 Codex worker 配置。
- `member-agent/test/build-runtime.test.ts`：布局、manifest、无 node_modules 导入、sidecar 缺失和恶意输出路径测试。
- `member-agent/test/codex-cli.test.ts`：Codex 配置、登录、本机检查与版本解析测试。
- `member-agent/test/codex-executor.test.ts`：适配器上下文、环境、路径、回调与错误映射测试。
- `member-agent/test/codex-integration.test.ts`：真实 Codex 0.160.0、打包适配器和回环假模型端到端测试。
- `member-agent/test/codex-lifecycle.test.ts`：任务生命周期、进程终止、结果错误与孙进程验证。
- `member-agent/test/codex-support.test.ts`：目录映射和技能复制/替换测试。
- `member-agent/test/codex-version.test.ts`：服务器固定版本匹配、告警与拒绝测试。
- `member-agent/test/fake-model-server.test.ts`：假模型仅绑定回环且延迟响应可用于取消验收。
- `member-agent/test/fixtures/fake-model-server.mjs`：成员验收用假 Responses 服务，支持可控延迟且不记录请求内容或头部。
- `member-agent/test/fixtures/lifecycle-executor.ts`：只用于自动化的生命周期与子孙进程夹具。

阶段 2 的 135 项原测试文件没有修改。没有编辑服务器、共享包或现有 Codex 适配器源码。`member-agent/package.json` 的运行时依赖仍只有精确锁定的 `ws@8.22.0`；esbuild 仅由打包脚本读取，用于构建，没有加入运行时依赖。

## 运行过的命令与完整输出

完整日志及首次失败/修正过程保存在本目录。主要命令：

```powershell
# 成员端全部自动化测试
node ..\node_modules\vitest\vitest.mjs run --config vitest.config.ts --cache=false --reporter=verbose

# 成员端类型检查
pnpm exec tsc --noEmit

# server 类型检查（阶段 3 没有修改 server 源码）
pnpm exec tsc --noEmit

# 阶段 1 九个回归文件
node ..\node_modules\vitest\vitest.mjs run --config vitest.config.ts --cache=false --reporter=verbose src/adapters/member-agent/protocol.test.ts src/__tests__/live-events-ws.test.ts src/adapters/registry.test.ts src/__tests__/adapter-registry.test.ts src/__tests__/agent-auth-jwt.test.ts src/__tests__/heartbeat-runtime-mcp-servers.test.ts src/__tests__/heartbeat-direct-adapter-native-isolation.test.ts src/services/heartbeat/run-lifecycle.test.ts src/services/heartbeat/recovery.test.ts

# 打包器
node .\member-agent\scripts\build-runtime.mjs
```

完整输出：`member-all-final2.log`（成员端 14 文件、201 测试通过，退出 0）、`phase1-regression.log`（9 文件、169 测试通过，退出 0）、`member-tsc-before.log` / `member-tsc-final2.log`、`server-tsc-before.log` / `server-tsc-after.log` 和 `build-final.log`。

首次失败也保留在：`member-all-attempt1.log`、`member-tsc-final-attempt1.log`、`codex-integration-attempt1.log`、`runtime-agent.log`、`patch-check-attempt1.log`。原因分别是新增配置路径初版带来错误数变化、主入口漏导入版本函数、集成断言要求了规格未要求的 event 帧、构建状态检查与并行新增文件时间重叠、四个新增文件尾部多一空行。问题已修正或收窄到规格要求，最终完整套件、类型检查和补丁空白检查均通过。阶段 1 回归及最终成员套件是在最后一次源码改动后执行。

## 验收项逐条结论

| 规格项 | 结论与测试依据 |
|---|---|
| 1. Runtime 构建 | 通过。`test/build-runtime.test.ts`：布局与 manifest、无 `node_modules` 祖先导入、两个 sidecar 缺失、三种越界 `--out` 共 7 个 case 通过；不产生 repo `out/`。 |
| 2. Context 字段 | 通过。`test/codex-executor.test.ts` 的 `constructs the cli context, localizes both cwd fields, and strips secrets from process.env` 捕获假适配器上下文，检查固定 `engine: cli`、绝对 `.exe`、不设置 model、运行令牌和禁止字段。 |
| 3. 执行线程环境 | 通过，同一上下文测试检查删掉长期 `PAPERCLIP_AGENT_KEY`、过滤 OpenAI/Anthropic 环境、设置正确 Paperclip API URL 与专属 `CODEX_HOME`。 |
| 4. 路径替换 | 通过。`test/codex-support.test.ts` 的 `prefers workspace project id then context project id and uses the configured default only if unmapped`、`rejects directories under Codex home or runtime and rejects a file as cwd`、`rejects a project directory whose symlink resolves inside CODEX_HOME`、`rewrites only local workspace fields and counts suspicious server paths without changing task text` 覆盖映射、缺目录/非法目录与上下文重写。执行器测试另外验证两个 cwd 字段都为本机目录、服务器路径不回传。 |
| 5. Handoff 摘要 | 通过。`test/codex-executor.test.ts` 的 `returns prior handoff text and removes legacy server handoff copies` 与 `returns null for an empty handoff`。 |
| 6. 结果映射 | 通过。`test/codex-executor.test.ts` 的 `maps a failing adapter exit without an error code to the Codex failure code`、`converts adapter exceptions to a short safe result without stack text`。 |
| 7. meta/usage | 通过。执行器 `maps spawn, meta, event, and usage callbacks`；`test/codex-lifecycle.test.ts` 验证有效帧通过、无效帧丢弃计数且不影响结果。 |
| 8. 进程树 | 通过。`test/codex-lifecycle.test.ts` 覆盖正常完成、取消、本机超时、断线、Ctrl+C shutdown、force 六条清理路径，且实际 Windows 子进程/孙进程均在清理后消失；还检查 taskkill 失败进入错误结果。 |
| 9. 技能物化 | 通过。`test/codex-support.test.ts` 覆盖缺失复制、相同跳过、不同内容替换、符号链接替换成真实目录、复制失败关闭。符号链接权限使用“创建链接一律抛 `EPERM`”的 `fs` 替身模拟；本机无需依赖开发者模式。 |
| 10. login/check | 通过。`test/codex-cli.test.ts` 覆盖独立检查、登录环境和假 `.exe` 登录；`test/cli.test.ts` 覆盖命令入口。auth 文件仅作存在性检查。 |
| 11. 版本门控 | 通过。`test/codex-version.test.ts` 覆盖相同版本、窗口内不同版本警告、窗口外/预发布/解析失败拒绝并保持连接。 |
| 12. 阶段 2 与类型检查 | 通过。阶段 2 的五个既有测试文件与新增 echoHoldSec 文件均未改，原 135 项通过；成员端 before/after 和 server before/after `tsc --noEmit` 均退出 0，新增 TypeScript 错误为 0。 |
| 集成测试 | 通过。`test/codex-integration.test.ts` 使用临时复制的真实 `codex.exe 0.160.0`、构建产物和随机回环假模型，经 JobRunner→Worker→适配器链路得到成功结果，并读到日志、meta、usage；没有真实账号或凭据。 |
| 阶段 1 回归 | 通过。协议与相关实时、registry、heartbeat 文件共 169 项通过；全程使用副本测试数据库/回环端口。 |
| 假模型验收脚本 | 通过。新增 `test/fake-model-server.test.ts` 检查只监听 `127.0.0.1`、可取消的延迟响应和非法延迟拒绝；`acceptance-parse.log` 中 17 个 PowerShell 代码块语法解析错误为 0。 |

本报告初次生成时，真实服务器 B1–B4 和真实账号 S1–S8 **未执行**。之后负责人批准独立部署停止确认补丁并进行 B3 真实取消验收，B3 已通过；2026-10-27 负责人提供了 B1、B4 与 S1–S8 全部通过的独立核对结果，见当前验收状态表。B3 的部署和运行证据见 `E:\workspace\paperclip-member-agent-dev\doc\plans\2026-10-26-member-agent-b3-fix-evidence\deployment-and-b3.md` 及其 `b3-a521a7be/` 子目录。负责人可复制执行的剩余命令、预期结果和独立读回方法见 [acceptance.md](acceptance.md)。

## 构建结果

`runtime/` 共 16 个文件、3,329,256 字节；Codex bundle 3,083,689 字节，其余附属文件与技能合计 245,567 字节。构建体积统计：workspace 2,018,873 bytes、zod 593,961 bytes、acpx 287,276 bytes、`@agentclientprotocol/sdk` 153,179 bytes。构建日志无警告。`runtime/` 被忽略且未进入补丁。

MANIFEST 样例（不含本机绝对路径）：

```json
{
  "builtAt": "2026-10-25T14:43:25.238Z",
  "repoCommit": "92371b0ec3ae6c849f47225a040c92f1e79516be",
  "adapterPackageVersion": "0.3.1",
  "bundleSha256": "594253496be0c5c965d271e7eeb41739291f252908f293de2f108b3041e157c1",
  "assets": {
    "server/dist/codex-auth-merge-decision.cjs": "86d7323e0eb4af87718c48efa4af28fb18b5c925ca42c91cd10337e696b45557",
    "server/dist/codex-auth-merge-extract.sh": "f6ba5e2d6310dc2ad743832a7ea46d0bd9dda64f233eda8b8953939bfedfb021"
  },
  "skills": { "paperclip": "caf8ec5e341c415240a0506aac2178138883294a184f5201876dfe40f4de36d5" },
  "esbuildVersion": "0.28.2",
  "nodeTarget": "node24"
}
```

`repoCommit` 是隔离副本初始化基线的 commit，未提交任何阶段 3 代码。构建产物只存在 E 盘隔离副本，被 `.gitignore` 排除。

## 阶段 3 规格第 12 节未决问题调查

1. **随代理打包的技能版本耦合**：`build-runtime.mjs` 从当前源码树复制 `skills/paperclip`，并将目录哈希写进 MANIFEST。服务器协议没有传送技能内容，也没有协商服务器与成员端技能哈希。因此成员端技能版本可能落后于服务器当前技能；要改成服务器下发需要负责人另行决定并修改协议，本阶段没有实现。
2. **`managedAiConnection`**：在 `packages/adapters/codex-local/src/server/execute.ts` 全部三处引用为第 681、854、861 行。它控制共享 Codex 登录缓存的访问和 sandbox home 的认证合并目标：关闭共享缓存 vend/按身份缓存写回，并把 auth merge 的 host 目标选到传入的专属 `CODEX_HOME`。它不绕过 `assertCodexCredentialsLaunchable` 登录/凭据就绪检查。成员端传 `true` 是为了把本机专属 `codexHome` 作为隔离边界；本地执行不启用远端 sandbox restore。没有读取或复制任何真实 `auth.json`，也未使用账号进行自动化测试。

S6 已在真实账号验收中确认会话续接，见当前验收状态表；运行版本窗口外的场景仍只有自动化覆盖。

## 交付物、隔离与本机服务核对

- 阶段 3 补丁：[phase3.patch](D:/paperclip/doc/plans/2026-10-25-member-agent-phase3-evidence/phase3.patch)。由独立临时 Git 索引以 D 盘当前 `member-agent/` 建基线，再叠加 E 盘实现生成；22 个路径全部在 `member-agent/` 下，无 runtime 构建产物。独立临时副本 `git apply --check` 退出码 0，`git diff --check` 退出码 0。**未把补丁应用到 D 盘。**详见 `patch-check.log`。
- 开工时 E/D `member-agent/` 排除 node_modules、runtime、`.git` 后各 27 个文件、内容逐个 SHA-256 相同。阶段 3 完成后有 22 个路径差异（8 修改、14 新增），清单见 `member-agent-diff.json`。
- D 盘开工前后 status 原始文件分别为 `d-git-status-before.txt` 和 `d-git-status-before-delivery.txt`；后者相对开工前只多出一份与本任务无关的中文 `.docx` 未跟踪文件，来源未确认，未读取、修改或删除。最终只在指定的 `doc/plans/2026-10-25-member-agent-phase3-evidence/` 目录增加交付物；最终状态见 `d-git-status-after.txt`，摘要见 `status-comparison.json`。没有编辑 D 盘源码或向其应用补丁。
- 本机 3100 健康检查只使用许可的 `GET http://localhost:3100/api/health`。工作前/完成后均为 PID `36504`、`processStartedAt=2026-10-25T12:03:57.742Z`、状态 `ok`；摘要见 `health-before.json` / `health-after.json`。没有向服务派发或取消任务，也没有重启/停止服务。
- 未运行项目仓库 commit 或 push。

## 偏离本规格的地方

无已知代码范围偏离。真实验收的范围与证据以当前验收状态表为准；S5 没有覆盖截断正在执行的命令，该行为由 S4 覆盖。

## 已知问题（2026-10-27）

1. 共享恢复提示（`packages/adapter-utils/src/server-utils.ts:2439` 等）会给 environment 交付方式的成员智能体列出不存在的工具名；目前由成员端操作说明兜底，共享提示未修改。
2. 父进程在结束进程树前已自行退出时，其遗留子进程无法按原父 PID 的进程树结束；本次真实测试未触发。
3. 服务器不下发模型；成员账号如只能使用特定模型，需在成员自己的 codex-home 中配置。
4. 智能体在运行失败或超时后显示为 `error`，下次成功运行后自动恢复 `idle`，这是平台统一行为。

## 真实验收完成记录

负责人已提供 A1–A8、B1–B4、S1–S8 全部通过的独立核对结果。B2、B3 使用假模型；真实账号项目以 S1–S8 表中事实为准。本轮只更新文档，未重跑验收或执行任何服务器操作。

## 后续验收补记（2026-10-26）

B3 已完成：真实服务器取消运行 `ec139891-435a-4e2e-8124-4a882810df5a`，获得服务端停止确认，固定版 Codex 根进程消失，且确认窗口内没有遗留的成员代理或假模型监听。详细时间、状态和证据路径见上述 `deployment-and-b3.md`。这项验收使用回环假模型，没有使用真实 Codex 账号；B3 通过不代表 B1、B4 或 S1–S8 已通过。B2（BOS-6）也已由 Claude 独立读回并通过。


## 集成测试稳定性修复同步记录（2026-10-27）

已将负责人验收通过的集成测试修复同步到 D:\paperclip。两个修复点是：进程在 taskkill 执行前后自然退出时，原进程树清理逻辑会报错并把成功任务判为失败；测试清理时刚运行过的 codex.exe 仍可能被 Windows 锁定，导致 EBUSY。修复后，taskkill 失败会再次确认目标进程是否存在，测试可执行文件也已移到每轮运行数据清理目录之外，并保留任务结果与脱敏日志的失败诊断。历史单次 exitCode=1 日志未保留 errorCode/errorMessage，无法据该日志追溯确定原因。

本轮在 D:\paperclip\member-agent 使用 --cache=false 连续运行指定集成测试 20 次，20 次通过、0 次失败；成员端全套 15 个测试文件、204 项通过；pnpm exec tsc --noEmit 退出码 0、无类型错误。三个补丁文件与 E 盘逐个 SHA-256 一致。完整测试输出、统计与同步前后 Git 状态保存在 E:\AI_Data\backups\paperclip\2026-10-27-before-flake-fix\。本轮没有启动本机 3100 服务。

已知局限：父进程在结束进程树前已自行退出时，其遗留子进程无法按原父 PID 的进程树结束，S4 已完成真实取消验收，本次未触发此局限。
