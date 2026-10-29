"""校验审核修复后的 ZIP 清单、源码和版本，并输出交付哈希。"""
import hashlib
import json
from pathlib import Path
from zipfile import ZipFile

repo = Path.cwd()
packages = []
for suffix in ("-codebuddy", ""):
    package = repo / f"member-agent/dist-installer/PaperclipMemberAgent-0.3.2{suffix}.zip"
    with ZipFile(package) as archive:
        names = archive.namelist()
        assert len(names) == len(set(names)), "ZIP 含重复条目"
        assert all("\\" not in name and not name.startswith("/") and ".." not in name.split("/") for name in names)
        manifest = json.loads(archive.read("MANIFEST.json"))
        assert manifest["agentVersion"] == "0.3.2"
        assert set(names) == {"MANIFEST.json"} | {file["path"] for file in manifest["files"]}
        for file in manifest["files"]:
            data = archive.read(file["path"])
            assert len(data) == file["size"], file["path"]
            assert hashlib.sha256(data).hexdigest() == file["sha256"], file["path"]
        assert json.loads(archive.read("app/member-agent/package.json"))["version"] == "0.3.2"
        sources = ["src/executors/echo.ts", "src/job-runner.ts"]
        if suffix:
            sources.extend(["src/executors/codebuddy.ts", "src/executors/codebuddy-launcher.ts"])
        for source in sources:
            assert archive.read(f"app/member-agent/{source}") == (repo / "member-agent" / source).read_bytes(), source
        print(f"{package.name}: agentVersion=0.3.2; manifestFiles={len(manifest['files'])}; 清单、ZIP 路径、版本与源码校验通过")
    with package.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    record = {"path": package.as_posix(), "bytes": package.stat().st_size, "sha256": digest}
    packages.append(record)
    print(json.dumps(record, ensure_ascii=False))
(Path(__file__).parent / "review-fix-packages.json").write_text(json.dumps(packages, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
