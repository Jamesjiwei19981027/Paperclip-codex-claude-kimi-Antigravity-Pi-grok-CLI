# 修复前 30 次失败明细

测试：uses the packaged adapter, real Codex 0.160.0 and a loopback fake model without credentials

运行总数：30；通过 26；失败 4。失败序号：7、18、26、27。

| 次数 | job.result.errorCode / errorMessage | 本次首个明确失败（清理） |
| --- | --- | --- |
| 7 | 原始运行日志没有打印，无法确认 | EBUSY；EBUSY: resource busy or locked, unlink 'C:\Users\11580\AppData\Local\Temp\member-codex-integration-doCAIv\codex-0.160.0.exe' |
| 18 | 原始运行日志没有打印，无法确认 | EBUSY；EBUSY: resource busy or locked, unlink 'C:\Users\11580\AppData\Local\Temp\member-codex-integration-fst10A\codex-0.160.0.exe' |
| 26 | 原始运行日志没有打印，无法确认 | EBUSY；EBUSY: resource busy or locked, unlink 'C:\Users\11580\AppData\Local\Temp\member-codex-integration-8FcHyP\codex-0.160.0.exe' |
| 27 | 原始运行日志没有打印，无法确认 | EBUSY；EBUSY: resource busy or locked, unlink 'C:\Users\11580\AppData\Local\Temp\member-codex-integration-TH79lc\codex-0.160.0.exe' |

这四次日志的 Vitest 失败原因是 afterEach 删除临时目录时的 EBUSY；每次 job.result 的 errorCode、errorMessage、summary 和日志均未由旧测试输出，不能从清理异常推断这些字段。逐次原始输出在 baseline-runs/run-07.log、run-18.log、run-26.log、run-27.log；全量统计在 baseline-30-summary.json。

之前报告的另一条 job.result.exitCode=1、timedOut=false 记录只显示断言对象摘要，省略字段，没有留下 errorCode/errorMessage。该次具体字段无法事后恢复。新增诊断会在后续 job.result 失败时输出这些字段和最近八条经过 JobRunner 现有脱敏的 job.log；如果 afterEach 清理失败，也会连同已捕获的 job.result 诊断一起输出。