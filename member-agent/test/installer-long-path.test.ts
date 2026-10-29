import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const library = fileURLToPath(new URL("../installer/uninstall.ps1", import.meta.url));
function run(shell: string, command: string, env: Record<string, string>) {
  return spawnSync(shell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand",
    Buffer.from("$ErrorActionPreference='Stop'; [Console]::OutputEncoding=New-Object Text.UTF8Encoding($false); " + command, "utf16le").toString("base64")], {
    env: { ...process.env, ...env, PMA_LIBRARY: library }, encoding: "utf8", windowsHide: true, timeout: 20_000,
  });
}
describe.skipIf(process.platform !== "win32")("native Windows cache cleanup", () => {
  for (const shell of ["powershell.exe", "pwsh.exe"]) {
    it(`${shell} removes an exactly 261-character junction without changing its target`, async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "paperclip-long-cache-"));
      try {
        const config = path.join(dir, "config"), cache = path.join(config, "codebuddy-home/paperclip-runtime");
        const target = path.join(dir, "target");
        await mkdir(target); await writeFile(path.join(target, "keep.txt"), "target survives");
        const parent = path.join(cache, "x".repeat(261 - cache.length - "\\paperclip".length - 1));
        const junction = path.join(parent, "paperclip");
        expect(junction.length).toBe(261);
        await mkdir(parent, { recursive: true });
        const made = run("pwsh.exe", "New-Item -ItemType Junction -Path $env:PMA_LINK -Target $env:PMA_TARGET | Out-Null", { PMA_LINK: junction, PMA_TARGET: target });
        expect(made.status, made.stdout + made.stderr).toBe(0);
        expect((await lstat(junction)).isSymbolicLink()).toBe(true);
        const result = run(shell, ". $env:PMA_LIBRARY -Library; Remove-CodeBuddyRuntimeCache $env:PMA_CONFIG", { PMA_CONFIG: config });
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(await lstat(cache).catch(() => null)).toBeNull();
        expect((await lstat(target)).isDirectory()).toBe(true);
        expect(await readFile(path.join(target, "keep.txt"), "utf8")).toBe("target survives");
      } finally { await rm(dir, { recursive: true, force: true }); }
    });
    it(`${shell} reports the Win32 error code when a cache file is locked and succeeds after release`, async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "paperclip-locked-cache-"));
      try {
        const config = path.join(dir, "config"), cache = path.join(config, "codebuddy-home/paperclip-runtime");
        await mkdir(cache, { recursive: true });
        const file = path.join(cache, "locked.txt"); await writeFile(file, "locked");
        const result = run(shell, `. $env:PMA_LIBRARY -Library
$stream=[IO.File]::Open($env:PMA_FILE,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
try { Remove-CodeBuddyRuntimeCache $env:PMA_CONFIG; exit 99 }
catch { Write-Output $_.Exception.Message; exit 7 }
finally { $stream.Dispose() }`, { PMA_CONFIG: config, PMA_FILE: file });
        expect(result.status, result.stdout + result.stderr).toBe(7);
        expect(result.stdout).toContain("清理 CodeBuddy 运行缓存失败");
        expect(result.stdout).toContain("Win32 错误码 32");
        expect(await readFile(file, "utf8")).toBe("locked");
        const retry = run(shell, ". $env:PMA_LIBRARY -Library; Remove-CodeBuddyRuntimeCache $env:PMA_CONFIG", { PMA_CONFIG: config });
        expect(retry.status, retry.stdout + retry.stderr).toBe(0);
        expect(await lstat(cache).catch(() => null)).toBeNull();
      } finally { await rm(dir, { recursive: true, force: true }); }
    });
  }
});
