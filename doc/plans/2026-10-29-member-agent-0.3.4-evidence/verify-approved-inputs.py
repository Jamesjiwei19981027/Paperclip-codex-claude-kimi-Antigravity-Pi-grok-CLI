"""Validate the prior delivered ZIPs before reusing their extracted vendor files."""
import hashlib
import json
from pathlib import Path
from zipfile import ZipFile

repo = Path.cwd()
evidence = Path(__file__).parent
approved = {
    "-codebuddy": "637d4e580c56448886a98773a7bb643c3437ad4dcec9247eecfaa0a7dd0d2910",
    "": "5128c88be25ca4d5a16be4a32a6524b5e733eab3856bd8b639ebcf74abb3be61",
}
records = {}
def require(condition, message):
    if not condition:
        raise RuntimeError(message)

for suffix, expected in approved.items():
    relative = Path(f"member-agent/dist-installer/PaperclipMemberAgent-0.3.3{suffix}.zip")
    archive_path = repo / relative
    with archive_path.open("rb") as stream:
        require(hashlib.file_digest(stream, "sha256").hexdigest() == expected, "Approved ZIP SHA-256 mismatch")
    with ZipFile(archive_path) as archive:
        manifest_bytes = archive.read("MANIFEST.json")
        manifest = json.loads(manifest_bytes)
        require(manifest["agentVersion"] == "0.3.3", "Input release version mismatch")
        require(len(archive.namelist()) == len(set(archive.namelist())), "Duplicate ZIP entries")
        require(all("\\" not in name and not name.startswith("/") and ":" not in name and ".." not in name.split("/") for name in archive.namelist()), "Unsafe ZIP path")
        require(set(archive.namelist()) == {"MANIFEST.json"} | {e["path"] for e in manifest["files"]}, "ZIP file set mismatch")
        expanded = archive_path.with_suffix("")
        require((expanded / "MANIFEST.json").read_bytes() == manifest_bytes, "Expanded manifest mismatch")
        checked = 0
        for entry in manifest["files"]:
            data = archive.read(entry["path"])
            require(len(data) == entry["size"], "ZIP entry size mismatch")
            require(hashlib.sha256(data).hexdigest() == entry["sha256"], "ZIP entry SHA-256 mismatch")
            if entry["path"].startswith(("app/codebuddy/", "app/node/", "app/codex/")):
                extended = Path(chr(92) * 2 + "?" + chr(92) + str(expanded / entry["path"]))
                require(extended.read_bytes() == data, "Expanded vendor bytes mismatch")
                checked += 1
        print(f"{relative.as_posix()}: approved ZIP SHA-256 PASS; manifest and {checked} extracted vendor files PASS", flush=True)
        records["codebuddy" if suffix else "codex"] = {
            "directory": expanded.relative_to(repo).as_posix(),
            "manifestSha256": hashlib.sha256(manifest_bytes).hexdigest(),
        }
(evidence / "approved-inputs.json").write_text(json.dumps(records, indent=2) + "\n", encoding="utf-8")
