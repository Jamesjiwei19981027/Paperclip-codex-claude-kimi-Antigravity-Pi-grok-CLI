"""脱敏任务 I 的日志，统一为 UTF-8，保留验证计数和包哈希。"""
import json
import os
import re
from pathlib import Path

folder = Path(__file__).parent
changed = []
for file in [*folder.glob("revert-review-*.txt"), *folder.glob("revert-review-*.json"), folder / "report.md"]:
    raw = file.read_bytes()
    text = raw.decode("utf-16" if raw.startswith((b"\xff\xfe", b"\xfe\xff")) else "utf-8-sig")
    profile = os.environ.get("USERPROFILE", "")
    for value in [profile.replace("\\", "\\\\"), profile.replace("\\", "/"), profile]:
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
