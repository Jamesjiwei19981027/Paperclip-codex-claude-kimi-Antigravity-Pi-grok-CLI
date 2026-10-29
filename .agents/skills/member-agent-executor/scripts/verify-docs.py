"""只读检查技能正文中的仓库源码引用和相对文档链接，不运行产品测试。"""

from pathlib import Path
import re
import sys


skill = Path(__file__).resolve().parents[1]
repo = skill.parents[2]
source_pattern = re.compile(
    r"(?<![\w/])(?:member-agent|server|ui|packages|doc|skills|\.agents)/"
    r"[A-Za-z0-9_./\-\u4e00-\u9fff]+\.(?:tsx|ts|mjs|cjs|ps1|jsonl|json|md|py)"
)
link_pattern = re.compile(r"\]\(([^)]+)\)")
sources = set()
links = set()
missing = []
for document in sorted(skill.rglob("*.md")):
    content = document.read_text(encoding="utf-8")
    for reference in source_pattern.findall(content):
        sources.add(reference)
    for target in link_pattern.findall(content):
        if "://" in target or target.startswith("#"):
            continue
        target = target.split("#", 1)[0]
        resolved = (document.parent / target).resolve()
        links.add(str(resolved.relative_to(skill)))
        if not resolved.is_file():
            missing.append(f"文档链接：{document.name} → {target}")
for reference in sorted(sources):
    if not (repo / reference).is_file():
        missing.append(f"仓库引用：{reference}")

print(f"仓库文件引用：{len(sources)}；技能相对链接：{len(links)}；缺失：{len(missing)}")
for message in missing:
    print(message)
print("文件行数：")
for file in sorted(skill.rglob("*")):
    if file.is_file():
        print(f"{file.relative_to(skill).as_posix()}：{len(file.read_text(encoding='utf-8').splitlines())}")
sys.exit(1 if missing else 0)
