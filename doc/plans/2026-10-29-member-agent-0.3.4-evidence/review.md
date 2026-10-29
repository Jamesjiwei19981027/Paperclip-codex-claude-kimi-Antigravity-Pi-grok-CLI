# 任务 K 独立只读审查

日期：2026-10-29。审查代理：Popper。

审查范围：共用 Windows 路径枚举和缓存清理、长路径测试、第三方文件离线复用入口、构建与来源核验脚本。

发现一项 P2：`verify-approved-inputs.py` 用 Python `assert` 承担固定 ZIP SHA-256、清单及文件核验。在 `python -O` 或 `PYTHONOPTIMIZE` 环境下，断言会被移除，脚本仍可生成批准记录。

处理：改成 `require` 中的显式条件与异常。以 `python -O` 重新核验两个真实旧包，并用错误摘要的负例确认优化模式仍拒绝输入；证据见 `approved-inputs-optimized.txt`、`optimized-validator-negative.txt`。

其余指定范围未发现可确认的行为缺陷。审查仅静态只读，不代替实际 Windows 回归测试。
