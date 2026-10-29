"""Verify both delivered archives against their manifests and current sources."""
import hashlib
import json
import subprocess
from pathlib import Path
from zipfile import ZipFile

if not __debug__:
    raise RuntimeError("Package verification requires enabled assertions; optimized mode is refused.")

repo = Path.cwd()
evidence = Path(__file__).parent
packages = []
for suffix in ("-codebuddy", ""):
    relative = Path(f"member-agent/dist-installer/PaperclipMemberAgent-0.3.4{suffix}.zip")
    package = repo / relative
    with ZipFile(package) as archive:
        names = archive.namelist()
        assert len(names) == len(set(names)), "Duplicate ZIP entries"
        assert all("\\" not in name and not name.startswith("/") and ".." not in name.split("/") for name in names)
        manifest = json.loads(archive.read("MANIFEST.json"))
        assert manifest["agentVersion"] == "0.3.4"
        assert set(names) == {"MANIFEST.json"} | {entry["path"] for entry in manifest["files"]}
        for entry in manifest["files"]:
            data = archive.read(entry["path"])
            assert len(data) == entry["size"], entry["path"]
            assert hashlib.sha256(data).hexdigest() == entry["sha256"], entry["path"]
        assert json.loads(archive.read("app/member-agent/package.json"))["version"] == "0.3.4"
        assert 'AGENT_VERSION = "0.3.4"' in archive.read("app/member-agent/src/executors/echo.ts").decode()
        for source in (repo / "member-agent/src").rglob("*.ts"):
            if not suffix and source.name.startswith("codebuddy"):
                continue
            name = "app/member-agent/" + source.relative_to(repo / "member-agent").as_posix()
            assert archive.read(name) == source.read_bytes(), name
        for source in (repo / "member-agent/installer").iterdir():
            if source.name not in ("install.ps1", "uninstall.ps1", "start.ps1", "README-成员安装说明.md"):
                continue
            name = "app/start.ps1" if source.name == "start.ps1" else source.name
            assert archive.read(name) == source.read_bytes(), name
        runtime = json.loads(archive.read("app/member-agent/runtime/MANIFEST.json"))
        assert runtime == manifest["runtimeManifest"]
        for asset, digest in runtime["assets"].items():
            data = archive.read("app/member-agent/runtime/" + asset)
            assert hashlib.sha256(data).hexdigest() == digest, asset
            assert data == (repo / "member-agent/runtime" / asset).read_bytes(), asset
        if suffix:
            assert manifest["codebuddyVersion"] == "2.169.0"
            assert "server/dist/claude-local.mjs" in runtime["assets"]
            runtime_source = archive.read("app/member-agent/runtime/server/dist/claude-local.mjs").decode()
            assert "dereference: true" in runtime_source
        else:
            assert manifest["codexVersion"] == "0.160.0"
            assert not any(name.startswith("app/codebuddy/") for name in names)
            assert "server/dist/claude-local.mjs" not in runtime["assets"]
        print(f"{package.name}: agentVersion=0.3.4; manifestFiles={len(manifest['files'])}; ZIP paths, file hashes, runtime assets and current sources PASS")
    expanded = package.with_suffix("")
    result = subprocess.run(
        [str(expanded / "app/node/node.exe"), str(expanded / "app/member-agent/src/main.ts"), "version"],
        capture_output=True, text=True, encoding="utf-8", check=True, timeout=20,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    assert result.stdout.strip() == "0.3.4", result.stdout
    print(f"{package.name}: packaged node + main.ts version -> {result.stdout.strip()}; exitCode={result.returncode}")
    with package.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    record = {"path": relative.as_posix(), "bytes": package.stat().st_size, "sha256": digest}
    packages.append(record)
    print(json.dumps(record))
(evidence / "packages.json").write_text(json.dumps(packages, indent=2) + "\n", encoding="utf-8")
