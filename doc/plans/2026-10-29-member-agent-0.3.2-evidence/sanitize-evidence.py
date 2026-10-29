"""仅对两轮公开证据脱敏，并重新解析 JSON / JSONL。"""
import json
import os
import re
from pathlib import Path

folders = [Path("doc/plans/2026-10-29-member-agent-0.3.1-evidence"), Path(__file__).resolve().parent]
profile = os.environ["USERPROFILE"]
hostname = os.environ.get("COMPUTERNAME", "")
username = os.environ.get("USERNAME", "")
changed = []
parsed = []
for folder in folders:
    for file in sorted(folder.rglob("*")):
        if not file.is_file():
            continue
        original = file.read_bytes()
        text = original.decode("utf-8-sig")
        for value in [profile.replace("\\", "\\\\"), profile.replace("\\", "/"), profile]:
            text = re.sub(re.escape(value), lambda _: "%USERPROFILE%", text, flags=re.I)
        # Also cover another local user's directory in captured test diagnostics.
        for pattern in [r"[A-Z]:\\\\Users\\\\[^\\\s\"']+", r"[A-Z]:[\\/]Users[\\/][^\\/\s\"']+"]:
            text = re.sub(pattern, lambda _: "%USERPROFILE%", text, flags=re.I)
        if hostname:
            text = re.sub(re.escape(hostname), lambda _: "%HOSTNAME%", text, flags=re.I)
        if username:
            text = re.sub(r"(?<!\w)" + re.escape(username) + r"(?!\w)", lambda _: "%USERNAME%", text, flags=re.I)
        encoded = text.encode("utf-8")
        if encoded != original:
            file.write_bytes(encoded)
            changed.append(file.name)
        if file.suffix == ".json":
            json.loads(text)
            parsed.append(file.name)
        elif file.suffix == ".jsonl":
            for line in text.splitlines():
                if line.strip():
                    json.loads(line)
            parsed.append(file.name)
print(json.dumps({"changed": changed, "json_or_jsonl_parsed": parsed}, ensure_ascii=False))
