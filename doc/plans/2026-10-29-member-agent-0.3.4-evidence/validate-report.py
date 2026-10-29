"""Check report evidence links, measured package records, and local-identity removal."""
import getpass
import json
import os
import re
import socket
from pathlib import Path

root = Path(__file__).parent
report = (root / "report.md").read_text(encoding="utf-8")
for target in re.findall(r"\]\(([^)]+)\)", report):
    if not (root / target).is_file():
        raise RuntimeError("Missing linked evidence: " + target)
for package in json.loads((root / "packages.json").read_text(encoding="utf-8")):
    for field in ("path", "bytes", "sha256"):
        if str(package[field]) not in report:
            raise RuntimeError("Measured package field absent from report")
for expected in ("532 passed (532)", "36 passed (36)", "Win32 错误码 32", "261 字符", "180 秒"):
    if expected not in report:
        raise RuntimeError("Required acceptance evidence absent: " + expected)
private = {socket.gethostname(), getpass.getuser(), os.environ.get("USERDOMAIN", ""), os.environ.get("COMPUTERNAME", "")} - {""}
for file in root.iterdir():
    if file.is_file() and file.suffix in (".md", ".txt", ".json", ".mjs", ".py"):
        text = file.read_text(encoding="utf-8")
        if any(re.search(re.escape(value), text, re.IGNORECASE) for value in private):
            raise RuntimeError("Local identity remains in evidence: " + file.name)
print("PASS: report links resolve, measured package records and test counts match, local identity absent.")
