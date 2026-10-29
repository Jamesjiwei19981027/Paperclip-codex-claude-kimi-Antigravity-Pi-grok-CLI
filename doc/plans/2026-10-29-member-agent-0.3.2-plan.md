# CodeBuddy 成员代理 0.3.2 修复与验收

按任务 G 的既定方案在当前工作树内顺序执行，不提交、不切换、不清理已有改动，不改主目录、不安装联接依赖、不改 claude-local 登录识别。

- [x] 在 codebuddy-executor 测试中覆盖成功终态覆盖误判、失败登录映射和失败边界；添加 Read 技能文本的 stream-json fixture，实际调用打包的 claude_local execute 后再归一化。
- [x] 在 job-runner 测试与测试执行器中覆盖零退出带错误码、超时和非零退出的本机失败日志。
- [x] 最小修改 codebuddy.ts 与 job-runner.ts；CodeBuddy 四种任务载体加入 PowerShell 中文 JSON 的 UTF-8 字节说明，不改变启动器阈值。
- [x] package、lock、echo、测试引用与成员安装文档更新到 0.3.2；先 build-runtime，再运行成员全量 Vitest、tsc、UI member-agent 测试与 token gates。
- [x] 使用上一轮 Node ZIP 缓存与构建命令打两个变体；用 PS 5.1 短目录解压、自检，记录真实退出码、耗时、大小、SHA-256 与限制。
- [x] 脱敏两轮证据，JSON/jsonl 重新解析，敏感词 rg 空结果；保存原始输出（仅脱敏）和最终报告，核查源码与包一致性。

验收证据放在同日期 0.3.2-evidence 目录。回放使用合成 CLI，不冒充重新派发的远端真机任务；安装自检使用隔离布局与假 WebSocket 握手，不覆盖用户安装。
