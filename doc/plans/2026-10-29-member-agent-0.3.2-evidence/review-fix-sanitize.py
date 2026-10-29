"""仅脱敏本次审核修复日志，保留测试、构建和哈希原始内容。"""
import json
import os
import re
from pathlib import Path

folder = Path(__file__).parent
changed = []
files = [*folder.glob("review-fix-*.txt"), *folder.glob("review-fix-*.json"), folder / "report.md"]
for file in files:
    raw = file.read_bytes()
    text = raw.decode("utf-16" if raw.startswith((b"\xff\xfe", b"\xfe\xff")) else "utf-8-sig")
    for value in [os.environ.get("USERPROFILE", "").replace("\\", "\\\\"), os.environ.get("USERPROFILE", "").replace("\\", "/"), os.environ.get("USERPROFILE", "")]:
        if value:
            text = re.sub(re.escape(value), lambda _: "%USERPROFILE%", text, flags=re.I)
    for name, replacement in [("COMPUTERNAME", "%HOSTNAME%"), ("USERNAME", "%USERNAME%")]:
        value = os.environ.get(name, "")
        if value:
            text = re.sub(re.escape(value), lambda _: replacement, text, flags=re.I)
    assert all(value.lower() not in text.lower() for value in [os.environ.get("COMPUTERNAME", ""), os.environ.get("USERNAME", "")] if value), file.name
    if file.suffix == ".json":
        json.loads(text)
    if text.encode("utf-8") != raw:
        file.write_text(text, encoding="utf-8")
        changed.append(file.name)
print(json.dumps({"changed": changed, "sensitive_scan": "通过"}, ensure_ascii=False))
