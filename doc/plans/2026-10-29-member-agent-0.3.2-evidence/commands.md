# 本轮实际命令与范围

所有相对路径从指定工作树根目录开始。没有 git commit/stash/reset/checkout；没有向仓库或目录联接 node_modules 安装依赖；构建器与打包测试仅在新建的独立临时目录安装固定 CodeBuddy 依赖。

1. 在 member-agent 目录：
   - 修复前：`node ../node_modules/vitest/vitest.mjs run --cache=false test/codebuddy-executor.test.ts test/job-runner.test.ts`
   - 修复后：`node ../node_modules/vitest/vitest.mjs run --cache=false test/codebuddy-executor.test.ts test/codebuddy-launcher.test.ts test/job-runner.test.ts`
2. `node member-agent/scripts/build-runtime.mjs`
3. 在 member-agent 目录：`node ../node_modules/vitest/vitest.mjs run --cache=false`
4. `node node_modules/typescript/bin/tsc -p member-agent/tsconfig.json`
5. 在 ui 目录：`pnpm exec vitest run --cache=false src/adapters/member-agent/index.test.ts src/adapters/member-agent/codebuddy.test.ts`
6. `pnpm check:token-gates`
7. `node doc/plans/2026-10-29-member-agent-0.3.2-evidence/replay.mjs`
8. `node doc/plans/2026-10-29-member-agent-0.3.2-evidence/utf8-api.mjs`
9. `python .agents/skills/member-agent-executor/scripts/verify-docs.py`（输出编码设为 UTF-8）
10. `node member-agent/scripts/build-installer.mjs --executor codebuddy --node-zip E:/workspace/paperclip-member-agent-dev/doc/plans/2026-10-27-member-agent-phase6-evidence/downloads/node-v24.18.0-win-x64.zip`
11. `node member-agent/scripts/build-installer.mjs --node-zip E:/workspace/paperclip-member-agent-dev/doc/plans/2026-10-27-member-agent-phase6-evidence/downloads/node-v24.18.0-win-x64.zip`
12. `node doc/plans/2026-10-29-member-agent-0.3.2-evidence/check-packages.mjs`
13. 为保留逐条断言原始输出，另运行：在 member-agent 目录 `node ../node_modules/vitest/vitest.mjs run --cache=false --reporter=verbose test/codebuddy-executor.test.ts test/job-runner.test.ts`。
14. `python doc/plans/2026-10-29-member-agent-0.3.2-evidence/sanitize-evidence.py`，以及最终敏感词 rg 检查与 `git diff --check`。

回放 fixture 是本次故障特征的合成记录，工具结果包含当前 skills/paperclip/SKILL.md 原句。运行时实际启动合成 CLI 子进程，读取 init/assistant Read/user tool_result/result success 四行；不调用真实模型服务。

UTF-8 请求验证只访问随机本地回环 HTTP 端口。脚本首次收集进度输出时触发宿主 CLIXML 解析错误，保留两次收集失败日志；关闭 PowerShell 进度后成功记录字节读回断言，未修改产品逻辑。

runtime 清单里的 adapterPackageVersion=0.3.1 是复用的适配器包版本；本轮只升级成员代理 agentVersion=0.3.2，不改适配器版本。
