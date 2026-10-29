# Member agent 0.3.3 验收证据

日期：2026-10-29。

本轮在中断留下的工作树上继续，先执行了 `git status --short`、`git diff --stat` 和 `git diff`。上一轮的改动保留，没有执行 reset、checkout、stash 或提交。

## 盘点与补齐

接手时已存在 Windows 复制分支、安装/卸载共用的缓存清理函数、两条路径的清理调用、部分联接测试，以及 package.json、package-lock.json、AGENT_VERSION、版本断言和两份说明中的 0.3.3 更新。它们当时尚没有本轮完整验收与重新打包的证据。

本轮补齐以下缺口：

- `packages/adapters/claude-local/src/server/prompt-cache.ts`：Windows 使用 `fs.cp(source, destination, { recursive: true, dereference: true })`。递归复制时也解引用技能内部链接，确保不在目标缓存创建重解析点。非 Windows 仍调用原来的 `fs.symlink(source, destination)`。
- `member-agent/installer/uninstall.ps1`：清理指定缓存后扫描整个 ConfigDir，默认保留配置的卸载也拒绝缓存外的重解析点。
- `prompt-cache.test.ts`：用真实的技能内部 junction 加上拒绝 symlink 的探针，检查复制后的根目录、子目录和文件；检查相同 hash 不再复制、嵌套目标文件改变后 hash 更新、新副本读取新内容且旧副本保持原内容。
- `installer-scripts.test.ts`：使用各引擎实际执行 `New-Item -ItemType Junction`，覆盖已安装版本的同版本覆盖、缓存根联接、嵌套联接、缓存普通文件清理、默认保留配置卸载，以及缓存外联接在安装和默认卸载时均拒绝。每阶段检查目标目录和 `keep.txt` 仍存在、内容未变。
- 修正上一轮测试的目录存在性断言：`readFile` 不能判定目录不存在，现在使用 `lstat`；默认卸载还逐字比较保留的 config.json。

## 缓存 hash 与清理边界

`buildClaudePromptBundleKey` 的 SHA-256 包含 instructions、技能 key/runtimeName，以及 `hashPathContents` 递归读取的目录名、文件名和文件字节；遇到链接时解析目标并哈希目标内容。它不是仅对源路径做 hash。

因此内容相同时，`ensurePaperclipSkillSymlink` 对普通副本返回 `skipped` 是正确的；内容变化时进入新的 hash 目录。本轮测试实际修改内部 junction 目标里的嵌套文件，验证 bundleKey 改变、新副本更新、旧副本未变。无需在同一 key 下替换旧副本。

缓存清理仅允许 `<ConfigDir>\codebuddy-home\paperclip-runtime`。先用 `Assert-PlainPath` 检查 ConfigDir/codebuddy-home 及祖先；缓存根若是重解析点，只删除该入口。对普通缓存目录，遍历时先检查属性，遇到目录重解析点使用 `[IO.Directory]::Delete(path, $false)`，文件重解析点使用 `[IO.File]::Delete(path)`，不压入遍历栈。清除这些入口后删除剩余可再生缓存。安装和卸载都在扫描配置树前调用它，其他位置仍执行拒绝规则。

## 实际测试命令与执行保护

所有测试由 `run-command.mjs` 设置实际子进程 cwd 后运行；没有使用根 vitest 配置。监护脚本在连续 180 秒无 stdout/stderr 时，只终止该命令及其子进程树并返回 124。本轮测试全部自行结束，未触发此保护。

claude-local 工作目录为 `packages/adapters/claude-local`：

```text
node ../../../node_modules/vitest/vitest.mjs run src/server/prompt-cache.test.ts --cache=false --config vitest.config.ts --reporter=verbose
```

member-agent 工作目录为 `member-agent`：

```text
node ../node_modules/vitest/vitest.mjs run --cache=false --reporter=verbose
node ../node_modules/vitest/vitest.mjs run --cache=false --reporter=verbose test/installer-scripts.test.ts -t "legacy CodeBuddy runtime junctions|rejects junctions outside"
```

类型检查从仓库根执行：

```text
node node_modules/typescript/bin/tsc -p member-agent/tsconfig.json
```

## 原始输出：member-agent 全量与 tsc

完整逐项输出见 [member-agent-tests.txt](member-agent-tests.txt)。以下直接摘录汇总，未改写计数：

```text
 Test Files  35 passed (35)
      Tests  518 passed (518)
   Start at  16:23:09
   Duration  535.49s (tests 100%)


exitCode=0
```

类型检查：

```text
cwd=.
command=node node_modules/typescript/bin/tsc -p member-agent/tsconfig.json

exitCode=0
```

## 原始输出：claude-local prompt-cache

完整输出见 [prompt-cache-tests.txt](prompt-cache-tests.txt)：

```text
cwd=packages\adapters\claude-local
command=node ../../../node_modules/vitest/vitest.mjs run src/server/prompt-cache.test.ts --cache=false --config vitest.config.ts --reporter=verbose

 RUN  v5.0.3 D:/paperclip/.claude/worktrees/codebuddy-executor-6332a5/packages/adapters/claude-local

 ✓ src/server/prompt-cache.test.ts > copies Windows skills without attempting a reparse point and hashes their contents 55ms

 Test Files  1 passed (1)
      Tests  1 passed (1)
   Start at  16:22:11
   Duration  2.48s (transform 67%, import 30%, tests 2%)


exitCode=0
```

## 原始输出：新增安装器测试名称与结果

实际引擎为 Windows PowerShell 5.1.26100.9711 和 pwsh 7.6.9。每个引擎分别运行代码页 65001、936。以下 8 条通过记录直接摘自 [installer-regression.txt](installer-regression.txt)；该次仅筛选新增场景，其余 29 项跳过，它们随后全部纳入上面的全量测试。

```text
 ✓ test/installer-scripts.test.ts > isolated Windows installer scripts > powershell.exe codepage 65001 > cleans legacy CodeBuddy runtime junctions on overwrite and default uninstall while preserving targets 6108ms
 ✓ test/installer-scripts.test.ts > isolated Windows installer scripts > powershell.exe codepage 65001 > rejects junctions outside the regenerable cache on install and default uninstall 2828ms
 ✓ test/installer-scripts.test.ts > isolated Windows installer scripts > pwsh.exe codepage 65001 > cleans legacy CodeBuddy runtime junctions on overwrite and default uninstall while preserving targets 11081ms
 ✓ test/installer-scripts.test.ts > isolated Windows installer scripts > pwsh.exe codepage 65001 > rejects junctions outside the regenerable cache on install and default uninstall 4888ms
 ✓ test/installer-scripts.test.ts > isolated Windows installer scripts > powershell.exe codepage 936 > cleans legacy CodeBuddy runtime junctions on overwrite and default uninstall while preserving targets 6003ms
 ✓ test/installer-scripts.test.ts > isolated Windows installer scripts > powershell.exe codepage 936 > rejects junctions outside the regenerable cache on install and default uninstall 2663ms
 ✓ test/installer-scripts.test.ts > isolated Windows installer scripts > pwsh.exe codepage 936 > cleans legacy CodeBuddy runtime junctions on overwrite and default uninstall while preserving targets 10664ms
 ✓ test/installer-scripts.test.ts > isolated Windows installer scripts > pwsh.exe codepage 936 > rejects junctions outside the regenerable cache on install and default uninstall 4763ms
 Test Files  1 passed (1)
      Tests  8 passed | 29 skipped (37)
   Start at  16:22:15
   Duration  49.23s (tests 100%)


exitCode=0
```

## 失败调查

新增回归测试先复现了两个真实缺陷，原始失败输出保存在 [prompt-cache-red.txt](prompt-cache-red.txt) 和 [installer-red.txt](installer-red.txt)：

1. 仅设置 recursive 的复制会尝试保留技能内部 junction。在 symlink 被拒绝的条件下，复制未完成，读取缓存技能失败。启用 dereference 后同一回归通过。
2. 默认卸载保留配置时，未扫描 ConfigDir 中非删除目标的部分，缓存外 junction 被放过。两个引擎、两种代码页共 4 次失败均稳定落在“应拒绝但退出码为 0”的断言。加入完整扫描后这 4 项全部通过。

最终全量为 518/518，无失败、无跳过、退出码 0。没有本轮全量失败需要做单项五次复跑。负责人在 0.3.2 看到的 509/510 未提供失败名称或日志，本轮没有复现，无法判断其历史原因，不能据此称其为偶发，也不能把本轮复现的两个缺陷认定为同一问题。

## 构建与安装包校验

先执行 `node member-agent/scripts/build-runtime.mjs`，然后分别执行以下两条命令；安装包构建器也各自先重建 runtime：

```text
node member-agent/scripts/build-installer.mjs --executor codebuddy --node-zip <预下载的官方 Node ZIP>
node member-agent/scripts/build-installer.mjs --node-zip <预下载的官方 Node ZIP>
```

实际完整命令与构建输出见 [build-runtime.txt](build-runtime.txt)、[build-codebuddy.txt](build-codebuddy.txt)、[build-codex.txt](build-codex.txt)，均为退出码 0。固定 Node/Codex/CodeBuddy 版本及来源校验保持原有规则。

成员代理版本是 0.3.3；runtime 输出中的 adapterPackageVersion=0.3.1 是复用的本地适配器包版本，两者独立。

重新读取两个 ZIP，验证全部文件长度与 SHA-256、条目完整性、无重复/越界路径、内外 runtime 清单一致、runtime asset 哈希、源码与安装脚本和当前工作树一致。CodeBuddy 包检查解引用复制已进入 bundle；Codex 包检查未带 CodeBuddy 文件和 Claude bundle。两份构建目录还分别使用包内 Node 执行 `main.ts version`，均输出 0.3.3、退出码 0。

以下是 [package-verification.txt](package-verification.txt) 原始输出，包含两个最终交付路径、字节数和独立重算的 SHA-256；机器可读记录见 [packages.json](packages.json)：

```text
cwd=.
command=python doc/plans/2026-10-29-member-agent-0.3.3-evidence/verify-packages.py
PaperclipMemberAgent-0.3.3-codebuddy.zip: agentVersion=0.3.3; manifestFiles=10461; ZIP paths, file hashes, runtime assets and current sources PASS
PaperclipMemberAgent-0.3.3-codebuddy.zip: packaged node + main.ts version -> 0.3.3; exitCode=0
{"path": "member-agent/dist-installer/PaperclipMemberAgent-0.3.3-codebuddy.zip", "bytes": 128848990, "sha256": "637d4e580c56448886a98773a7bb643c3437ad4dcec9247eecfaa0a7dd0d2910"}
PaperclipMemberAgent-0.3.3.zip: agentVersion=0.3.3; manifestFiles=65; ZIP paths, file hashes, runtime assets and current sources PASS
PaperclipMemberAgent-0.3.3.zip: packaged node + main.ts version -> 0.3.3; exitCode=0
{"path": "member-agent/dist-installer/PaperclipMemberAgent-0.3.3.zip", "bytes": 173268505, "sha256": "5128c88be25ca4d5a16be4a32a6524b5e733eab3856bd8b639ebcf74abb3be61"}

exitCode=0
```

## 交付范围与证据

本轮验收范围为成员代理、Claude prompt cache 和两个安装包。没有运行仓库级 typecheck/test/build 或浏览器套件；没有在本轮修改 UI，也没有创建 PR。以上结果不声明整个工作树已达到 PR-ready 状态。

命令输出只对本机身份信息做脱敏，测试名称、计数、时长、错误和退出码保留。最终身份检查见 [sanitization.txt](sanitization.txt)，补充检查见 [diff-check.txt](diff-check.txt)。

报告和两个 ZIP 保存在本工作树。已尝试仓库指定的 artifact helper，因缺少 `jq` 退出 1；当前会话也没有 Paperclip API、company、task、run 上下文，工具检索未发现可用的 Paperclip 上传连接器，因此未创建上传附件或 artifact work product。实际尝试与环境存在性检查见 [artifact-upload.txt](artifact-upload.txt)。没有修改任何 issue 状态。
