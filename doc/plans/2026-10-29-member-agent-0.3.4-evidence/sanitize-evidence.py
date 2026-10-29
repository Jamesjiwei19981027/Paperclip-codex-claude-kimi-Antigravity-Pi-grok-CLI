"""Remove local identity values, then scan every evidence file."""
import getpass
import os
import re
import socket
from pathlib import Path

root = Path(__file__).resolve().parent
private = {socket.gethostname(), getpass.getuser(), os.environ.get("USERDOMAIN"), os.environ.get("COMPUTERNAME")}
private.discard(None)
private.discard("")
for file in root.iterdir():
    if file.suffix not in (".txt", ".md", ".json", ".mjs", ".py"):
        continue
    text = file.read_text(encoding="utf-8")
    for token in private:
        text = re.sub(re.escape(token), "[redacted]", text, flags=re.IGNORECASE)
    text = re.sub(r'(<S N="(?:User|Computer)">).*?(</S>)', r"\1[redacted]\2", text)
    file.write_text(text, encoding="utf-8")
for file in root.iterdir():
    if not file.is_file():
        continue
    text = file.read_text(encoding="utf-8")
    assert not any(re.search(re.escape(token), text, re.IGNORECASE) for token in private), file.name
(root / "sanitization.txt").write_text("PASS: local account, domain and hostname values absent from all evidence files.\n", encoding="utf-8")
print("PASS: local account, domain and hostname values absent from all evidence files.")
