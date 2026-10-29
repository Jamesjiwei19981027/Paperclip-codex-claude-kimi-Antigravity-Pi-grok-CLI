import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";

it.each(["powershell.exe", "pwsh.exe"])("%s prints the manifest failure reason and relative path without the Key", async shell => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "pma-install-error-"));
  try {
    const rows = [];
    for (const name of ["install.ps1", "uninstall.ps1", "README-成员安装说明.md"]) {
      const bytes = await fs.readFile(path.resolve("installer", name)); await fs.writeFile(path.join(root, name), bytes);
      rows.push({ path: name, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    }
    await fs.writeFile(path.join(root, "MANIFEST.json"), JSON.stringify({ agentVersion: "0.3.2", nodeVersion: "24.18.0", codexVersion: "0.160.0", runtimeManifest: {}, builtAt: "test", repoCommit: "test", files: rows }));
    await fs.writeFile(path.join(root, "extra.zip"), "not listed");
    const script = `[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false); & $env:PMA_INSTALLER -TestMode -InstallRoot $env:PMA_INSTALL_ROOT -ConfigDir $env:PMA_CONFIG_DIR -TestExecutor $env:PMA_INSTALLER -TestNode $env:PMA_NODE`;
    const result = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true, timeout: 15000, env: { ...process.env, PMA_NODE: process.execPath, PMA_INSTALLER: path.join(root, "install.ps1"), PMA_INSTALL_ROOT: path.join(root, "installed"), PMA_CONFIG_DIR: path.join(root, "config"), PAPERCLIP_AGENT_KEY: "FAKE-SECRET-MUST-NOT-PRINT" } });
    expect(result.status).not.toBe(0);
    const output = result.stdout + result.stderr;
    expect(output).toContain("发现未列入清单的文件：extra.zip");
    expect(output).not.toContain("FAKE-SECRET-MUST-NOT-PRINT");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
