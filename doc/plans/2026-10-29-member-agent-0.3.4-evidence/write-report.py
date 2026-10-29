"""Assemble the final report from actual command logs and package measurements."""
import json
from pathlib import Path

root = Path(__file__).parent
def log(name):
    return (root / name).read_text(encoding="utf-8")

tests = log("member-agent-tests.txt")
if "exitCode=0" not in tests or "Tests  532 passed (532)" not in tests:
    raise RuntimeError("The complete expected member-agent suite has not passed")
for name in ("member-agent-tsc.txt", "build-runtime.txt", "build-installers.txt", "package-verification.txt"):
    if "exitCode=0" not in log(name):
        raise RuntimeError("Missing successful verification: " + name)
summary = tests[tests.rfind(" Test Files"):].strip()
regression = log("installer-regression.txt")
new_results = "\n".join(line for line in regression.splitlines() if " ✓ " in line and
    any(text in line for text in (">260-character", "261-character", "outside the regenerable", "Win32 error", "rejects reuse", "rejects tampered")))
packages = json.loads(log("packages.json"))
package_output = "\n".join(json.dumps(p, ensure_ascii=False) for p in packages)
report = f"""# 成员代理 0.3.4：任务 K 验收证据

日期：2026-10-29。工作树：`codebuddy-executor-6332a5`。

## 改动与根因

0.3.3 共用缓存清理依赖 PowerShell `Get-ChildItem` 和 .NET Framework `System.IO`。新增回归先在未修复代码上复现：Windows PowerShell 5.1 的代码页 65001、936 共 4 项失败，pwsh 对应 4 项通过；失败在枚举超长子树时发生，尚未到达旧的联接删除调用。原始输出见 [installer-long-path-red.txt](installer-long-path-red.txt)。

`member-agent/installer/uninstall.ps1` 中安装与卸载共用的清理现在使用：

- 字符码 92 构造扩展路径前缀，绝对路径传给 Win32 宽字符 API。
- `GetFileAttributesW`、`FindFirstFileW`、`FindNextFileW` 枚举并判断目录和重解析点。遇到重解析点不递归、不修改其目标属性。
- 目录和目录联接调用 `RemoveDirectoryW`；普通文件和文件链接调用 `DeleteFileW`。普通缓存文件的只读属性通过 `SetFileAttributesW` 清除，隐藏文件照常枚举。
- 检查删除返回值与枚举结束错误码，失败抛出中文原因和 Win32 错误码；最后通过 native 属性查询确认缓存根目录不存在。

缓存清理的唯一入口仍为 `<ConfigDir>\\codebuddy-home\\paperclip-runtime`，入口之前保留 `Assert-PlainPath` 的祖先校验。根缓存联接和嵌套联接只删除入口，目标目录及 `keep.txt` 均由真实文件系统断言检查保留。

扩展“缓存外超长联接”反例后发现：旧 `Get-PlainTree` 在 PS5.1 可静默遗漏超长子树，使安装错误地成功。第一次全量运行在该断言失败后由监护进程的准确 PID/子进程关系定向停止，原始输出保留于 [member-agent-tests-interrupted.txt](member-agent-tests-interrupted.txt)。未杀同名的其他进程。

因此 `Get-PlainTree` 也改为 native 枚举，并在返回普通树条目前检查重解析点。缓存以外的短路径、超长路径联接，安装和默认保留配置卸载均拒绝。此处加强安全扫描，不扩大允许删除联接的范围。

## 安装与卸载覆盖

测试引擎实测为 Windows PowerShell {log("powershell-version.txt").splitlines()[2].strip()} 与 pwsh {log("pwsh-version.txt").splitlines()[2].strip()}。每个引擎运行代码页 65001、936，临时路径含中文和空格。

新增两个安装器场景，各自覆盖同版本覆盖安装、默认保留配置卸载、重新安装后选择删除配置/独立 home/日志的卸载：

1. 超过 260 字符的真实目录联接，旁边放超长路径普通文件、隐藏文件及只读文件；联接由 pwsh 创建并检查确为重解析点。每一步确认缓存不存在，外部目标目录和文件仍存在且内容未变。
2. 没有联接、只有超长普通文件的复制缓存。安装及两种卸载均成功；默认卸载逐字保留 config.json，选择删除配置的卸载确认配置和独立 home 消失。

这验证了 `Remove-CodeBuddyRuntimeCache` 先于 ConfigDir 扫描执行：0.3.3 起复制的技能缓存即使含超长普通文件，也在 `Get-PlainTree` 和后续卸载配置删除前被清掉。

另有两种引擎的精确 **261 字符**联接回归，以及占用缓存文件的失败回归：持有不共享文件句柄时，中文错误包含 `Win32 错误码 32`，保留文件；句柄释放后可成功重试。

## 原始输出：新增名称与定向结果

命令从 member-agent 子目录执行，使用指定 vitest 入口和 `--cache=false`。完整定向输出见 [installer-regression.txt](installer-regression.txt)，以下直接摘录：

```text
{new_results}

{regression[regression.rfind(" Test Files"):].strip()}
```

## 原始输出：member-agent 全量与 tsc

全量命令：

```text
cwd=member-agent
node ../node_modules/vitest/vitest.mjs run --cache=false --reporter=verbose
```

完整输出见 [member-agent-tests.txt](member-agent-tests.txt)。汇总原文：

```text
{summary}
```

tsc 原始输出：

```text
{log("member-agent-tsc.txt").strip()}
```

## 无安装依赖的构建

本轮没有运行 npm/pnpm install，没有向 node_modules 安装依赖。标准 CodeBuddy 构建与其测试 beforeAll 原本会 npm install；本轮增加 `reuseVerifiedCodeBuddy` 模块入口，先核对独立记录批准的旧包 ZIP SHA-256，再验证 ZIP 文件全集及逐文件哈希、展开副本、固定 CodeBuddy 版本和 npm integrity。仅核验通过的第三方副本获得扫描凭据。

旧包的固定 SHA-256 来自上一轮已交付的证据，不从当前待验文件反推；复用不改变旧包、展开副本和主工作目录。来源证据见 [approved-inputs.txt](approved-inputs.txt)。独立审查指出 Python 优化模式移除 assert 的问题后，来源脚本改用显式异常；优化模式真实核验与错误摘要负例见 [approved-inputs-optimized.txt](approved-inputs-optimized.txt)、[optimized-validator-negative.txt](optimized-validator-negative.txt)，审查记录见 [review.md](review.md)。

先运行 `node member-agent/scripts/build-runtime.mjs`，再运行 `node doc/plans/2026-10-29-member-agent-0.3.4-evidence/build-without-install.mjs`。打包复用标准 `assembleInstaller`、`scanInstaller`、`archiveInstaller`，重建两个 0.3.4 包；Node/Codex 保留固定二进制哈希校验。命令与原始输出见 [build-runtime.txt](build-runtime.txt)、[build-installers.txt](build-installers.txt)。

成员版本 package.json、package-lock.json、AGENT_VERSION、测试版本引用和两份说明统一为 0.3.4。README 中“沿用 0.3.3”是历史行为说明。runtime 的 adapterPackageVersion 属于复用适配器版本，与成员代理版本独立。

## 两个交付包：路径、字节数与 SHA-256

重新打开 ZIP 校验所有条目大小、哈希、路径、文件全集，核对本轮源码及脚本，内外 runtime 清单和资产哈希一致；包内 Node 执行 `main.ts version` 必须输出 0.3.4。CodeBuddy 不含 Codex 二进制，默认 Codex 包不带 CodeBuddy 源文件、第三方目录或 Claude bundle。

以下记录来自最终包独立核验 [package-verification.txt](package-verification.txt)，机器可读记录见 [packages.json](packages.json)：

```text
{package_output}
```

## 边界、命令保护与交付范围

所有测试在对应子目录运行。`run-command.mjs` 捕获原始 stdout/stderr，仅脱敏本地身份并移除终端颜色；连续 180 秒无输出时仅终止该命令的进程树，返回 124。成功运行未触发该超时；没有反复空轮询。

保留接手时的全部既有改动；未执行 git commit/stash/reset/checkout，未写主工作目录，未安装依赖。验证范围为成员代理及其安装包，没有运行仓库级 typecheck/test/build 或浏览器测试，也没有创建 PR，不声明整个既有脏工作树达到 PR-ready。

技能文档引用检查见 [skills-doc-check.txt](skills-doc-check.txt)；最终脱敏检查见 [sanitization.txt](sanitization.txt)。报告和证据不含本地账号或主机名。

当前会话缺少 Paperclip API/company/task/run 上下文，工具检索没有找到可用的 Paperclip 附件上传工具。仓库 artifact helper 因缺少 `jq` 退出 1，实际结果见 [artifact-upload.txt](artifact-upload.txt)，上下文存在性检查见 [artifact-preflight.txt](artifact-preflight.txt)。两个 ZIP 与报告留在本工作树，未声称已上传，也未修改 issue 状态。
"""
(root / "report.md").write_text(report, encoding="utf-8")
print("PASS: report written from completed verification logs and measured package metadata.")
