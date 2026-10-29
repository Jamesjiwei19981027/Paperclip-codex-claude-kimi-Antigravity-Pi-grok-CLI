import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
const root = await fs.mkdtemp(path.join(tmpdir(), "pf031-error-"));
try {
  const rows = [];
  for (const name of ["install.ps1", "uninstall.ps1", "README-成员安装说明.md"]) {
    const bytes = await fs.readFile(path.resolve("member-agent/installer", name)); await fs.writeFile(path.join(root, name), bytes);
    rows.push({ path: name, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  await fs.writeFile(path.join(root, "MANIFEST.json"), JSON.stringify({ agentVersion: "0.3.1", nodeVersion: "24.18.0", codexVersion: "0.160.0", runtimeManifest: {}, builtAt: "test", repoCommit: "test", files: rows }));
  await fs.writeFile(path.join(root, "extra.zip"), "unlisted archive");
  for (const shell of ["powershell.exe", "pwsh.exe"]) {
    const script = `[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false); & $env:PMA_INSTALLER -TestMode -InstallRoot $env:PMA_ROOT -ConfigDir $env:PMA_CONFIG -TestExecutor $env:PMA_INSTALLER -TestNode $env:PMA_NODE`;
    const result = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { env: { ...process.env, PMA_INSTALLER: path.join(root, "install.ps1"), PMA_ROOT: path.join(root, "installed"), PMA_CONFIG: path.join(root, "config"), PMA_NODE: process.execPath, PAPERCLIP_AGENT_KEY: "FAKE-SECRET-MUST-NOT-PRINT" }, encoding: "utf8", windowsHide: true });
    console.log(`${shell}: exitCode=${result.status}`); console.log(result.stdout.trim());
    if (result.status === 0 || !result.stdout.includes("发现未列入清单的文件：extra.zip") || (result.stdout + result.stderr).includes("FAKE-SECRET-MUST-NOT-PRINT")) process.exitCode = 1;
  }
} finally { await fs.rm(root, { recursive: true, force: true }); }
