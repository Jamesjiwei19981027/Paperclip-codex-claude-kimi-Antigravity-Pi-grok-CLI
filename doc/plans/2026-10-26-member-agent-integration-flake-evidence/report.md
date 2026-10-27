# 成员端 Codex 集成测试间歇性失败排查

## 结论

修复了两个由证据确认的问题：Windows 测试清理时立即删除刚运行过的 Codex 映像会间歇性遇到 EBUSY；正常任务收尾时，Codex 进程可能先于 taskkill 自然退出，旧进程树逻辑仍把 taskkill 的失败认定为清理失败。第一项造成测试夹具失败，第二项的 job-runner 收尾路径会把成功的执行结果改成 exitCode 1。

之前日志中那次 exitCode 1、timedOut false 没有包含 errorCode 和 errorMessage。它不能被追溯为某个确定原因。代码与新红测确认，进程树竞态可产生 member_agent_process_tree_termination_failed；本轮新增诊断保留下一次 job.result 出错时的字段和脱敏日志。

## 修复前基线

指定集成测试以 --cache=false 连续运行 30 次：26 通过、4 失败（第 7、18、26、27 次）。4 次的首个明确失败都是 EBUSY unlink 临时目录中的 codex-0.160.0.exe；逐项错误消息及无法恢复的 job.result 字段见 baseline-failure-details.md。每次完整日志在 baseline-runs/。

直接原因是测试把 Codex 可执行文件复制到每次测试的临时根目录，afterEach 随即递归删除。Windows 可在子进程退出后短暂保持该映像文件锁定，导致删除失败。集成测试改为把固定版本的测试可执行文件存于 OS 临时缓存目录，测试结束时只清理运行数据目录。

## 产品竞态证据及修复

member-agent/src/process-tree.ts 原逻辑在初次确认 PID 存在后调用 taskkill；taskkill 一旦报错就直接抛出清理失败。member-agent/src/job-runner.ts:163-179 汇总此清理失败，:208-214 会把任务结果改成 exitCode 1、errorCode member_agent_process_tree_termination_failed。

新增红测模拟：初次 PID 检查存在，taskkill 执行期间目标自然退出并使 taskkill 报错。旧代码仍然拒绝（process-tree-red.log）。修复后，taskkill 失败时再次检查目标 PID；目标已退出则认为清理完成，仍存在则继续报告失败，避免把真实清理失败吞掉。新测试分别覆盖自然退出与目标仍存活两种情况（process-tree-green.log）。

## 文件与行号

- member-agent/src/process-tree.ts:18-22：taskkill 失败后复核 PID，区分自然退出竞态与实际失败。
- member-agent/test/process-tree.test.ts:14-39：新增的两种进程树竞态测试。
- member-agent/test/codex-integration.test.ts:18-26：测试用 Codex 映像缓存到每轮清理目录之外。
- member-agent/test/codex-integration.test.ts:28-40：清理失败时打印脱敏任务诊断。
- member-agent/test/codex-integration.test.ts:103-124：任务失败时输出 errorCode、errorMessage、summary 和最近八条 job.log；断言错误信息也包含这些诊断。job.result 经 JobRunner.safe 递归脱敏（member-agent/src/job-runner.ts:53-57），日志块经 redactor.chunk 脱敏（:155-160）。

## 验证

- 修复后指定集成测试连续 30 次通过：30/30，失败 0。汇总在 post-fix-30-summary.json，每次完整输出在 post-fix-runs/，逐次结果在 post-fix-30-attempts.txt。
- 成员端完整测试：15 个文件、204 项通过。完整输出：member-agent-full-final.log。
- 服务端 member-agent 两个测试文件：protocol.test.ts 与 cancellation.test.ts，共 49 项通过。完整输出：server-member-tests-final.log。
- member-agent pnpm exec tsc --noEmit：退出码 0、0 错误；输出 member-agent-tsc-final-verified.log。
- server pnpm exec tsc --noEmit：退出码 0、0 错误；输出 server-tsc-final-verified.log。
- 测试诊断只选取已由 JobRunner 脱敏后发送的 job.log 帧；没有写入 Key 或令牌。

## 补丁与隔离

补丁：fixes.patch，只包含 member-agent/src/process-tree.ts、member-agent/test/codex-integration.test.ts、member-agent/test/process-tree.test.ts。它以 D 盘当前两份文件为基线；新测试文件在 D 盘不存在，因此作为新增文件。D 盘源码 SHA-256 在检查前后完全一致，没有在 D:\paperclip 应用补丁。

git apply --check 在 E 盘建立的 D 源码临时快照上通过（退出码 0）；检查记录：patch-check.log。补丁 SHA-256 与目标文件清单也在该记录中。