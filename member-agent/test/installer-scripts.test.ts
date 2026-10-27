import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../installer/", import.meta.url));
const shells = process.platform === "win32" ? ["powershell.exe", "pwsh.exe"] : [];
const bom = async (file: string, source: string) => writeFile(file, "\uFEFF" + source, "utf8");
const exists = async (file: string) => readFile(file).then(() => true, () => false);
const json = async (file: string) => JSON.parse(await readFile(file, "utf8"));
const codePages = process.env.PMA_TEST_CODE_PAGE ? [Number(process.env.PMA_TEST_CODE_PAGE)] : [65001, 936];
if (codePages.some(cp => ![65001, 936].includes(cp))) throw new Error("Invalid installer test code page");
function executeAtCodePage(codePage: number, shell: string, file: string, args: string[]) {
  const env = { ...process.env }; delete env.PAPERCLIP_AGENT_KEY; delete env.CODEX_HOME;
  const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";
  // EncodedCommand preserves Unicode arguments through cmd under either code page.
  // The child shell still inherits the selected console code page.
  const command = `$ProgressPreference='SilentlyContinue'; & ${literal(file)} ${args.map(value => /^-[A-Za-z]+$/.test(value) ? value : literal(value)).join(" ")}; exit $LASTEXITCODE`;
  const encoded = Buffer.from(command, "utf16le").toString("base64");
  const result = spawnSync("cmd.exe", ["/d", "/s", "/c", `chcp ${codePage} >nul && ${shell} -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`], { timeout: 30_000, env, windowsHide: true });
  return { code: result.status, output: new TextDecoder(codePage === 936 ? "gbk" : "utf-8").decode(result.stdout ?? Buffer.alloc(0)) + new TextDecoder(codePage === 936 ? "gbk" : "utf-8").decode(result.stderr ?? Buffer.alloc(0)), error: result.error };
}
async function sandbox() {
  const dir = await mkdtemp(path.join(tmpdir(), "paperclip-installer-中文 空格-"));
  const install = path.join(dir, "程序 安装"), config = path.join(dir, "成员 配置");
  const cwd = path.join(dir, "项目 工作目录"); await mkdir(cwd);
  const executor = path.join(dir, "fake-executor.ps1"), wait = path.join(dir, "fake-wait.ps1");
  await bom(executor, `param($Mode,$ConfigPath,$VersionRoot)\n$d=Split-Path $ConfigPath\n[IO.File]::AppendAllText((Join-Path $d 'calls.txt'),$Mode+'|'+$VersionRoot+[Environment]::NewLine)\n$f=Join-Path $d 'codes.json'\n$codes=Get-Content -LiteralPath $f -Raw|ConvertFrom-Json\n$c=@($codes)[0]\n$remaining=@($codes|Select-Object -Skip 1)\n[IO.File]::WriteAllText($f,(ConvertTo-Json -InputObject $remaining -Compress))\nif($c -eq 'crash'){throw 'FAKE CRASH'}\nreturn [int]$c\n`);
  await bom(wait, `param($Seconds,$ConfigDir)\n[IO.File]::AppendAllText((Join-Path $ConfigDir 'waits.txt'),[string]$Seconds+[Environment]::NewLine)\n`);
  await mkdir(config, { recursive: true });
  const args = ["-TestMode", "-InstallRoot", install, "-ConfigDir", config];
  return { dir, cwd, install, config, executor, wait, args };
}
async function manifest(dir: string, version: string) {
  const files: { path: string; size: number; sha256: string }[] = [];
  async function walk(base: string) { for (const entry of await readdir(path.join(dir, base), { withFileTypes: true })) {
    const relative = path.posix.join(base, entry.name);
    if (entry.isDirectory()) await walk(relative);
    else if (relative !== "MANIFEST.json") { const data = await readFile(path.join(dir, relative)); files.push({ path: relative, size: data.length, sha256: createHash("sha256").update(data).digest("hex") }); }
  } }
  await walk(""); await writeFile(path.join(dir, "MANIFEST.json"), JSON.stringify({ agentVersion: version, nodeVersion: "24.18.0", codexVersion: "0.160.0", runtimeManifest: {}, builtAt: "test", repoCommit: "test", files }));
}
async function pack(dir: string, version: string) {
  const out = path.join(dir, "package-" + version); await mkdir(out);
  for (const name of ["install.ps1", "uninstall.ps1", "README-成员安装说明.md"]) await cp(path.join(root, name), path.join(out, name));
  await mkdir(path.join(out, "app/member-agent/src"), { recursive: true });
  await mkdir(path.join(out, "app/member-agent/runtime"), { recursive: true });
  await mkdir(path.join(out, "app/node"), { recursive: true }); await mkdir(path.join(out, "app/codex"));
  await cp(path.join(root, "start.ps1"), path.join(out, "app/start.ps1"));
  for (const name of ["app/node/node.exe", "app/codex/codex.exe", "app/codex/codex-code-mode-host.exe"]) await writeFile(path.join(out, name), "FAKE-NOT-EXECUTABLE");
  await cp(new URL("../src/config.ts", import.meta.url), path.join(out, "app/member-agent/src/config.ts"));
  await cp(new URL("../src/transport-check.ts", import.meta.url), path.join(out, "app/member-agent/src/transport-check.ts"));
  await cp(new URL("../src/logger.ts", import.meta.url), path.join(out, "app/member-agent/src/logger.ts"));
  await writeFile(path.join(out, "app/member-agent/src/main.ts"), "// Fake installer package; never run.");
  await writeFile(path.join(out, "app/member-agent/package.json"), '{"type":"module"}');
  await manifest(out, version); return out;
}
describe.skipIf(process.platform !== "win32")("isolated Windows installer scripts", () => {
  it("every executable script has UTF-8 BOM and parses in both engines", async () => {
    for (const name of ["install.ps1", "start.ps1", "uninstall.ps1"]) {
      const file = path.join(root, name), data = await readFile(file);
      expect([...data.subarray(0, 3)]).toEqual([239, 187, 191]);
      for (const shell of shells) { const result = spawnSync(shell, ["-NoProfile", "-Command", `$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${file.replaceAll("'", "''")}',[ref]$t,[ref]$e);if($e.Count){$e|Out-String|Write-Output;exit 1}`], { encoding: "utf8" }); expect(result.status, result.stdout + result.stderr).toBe(0); }
    }
  });
  for (const codePage of codePages) for (const shell of shells) describe(`${shell} codepage ${codePage}`, () => {
    const execute = (shell: string, file: string, args: string[]) => executeAtCodePage(codePage, shell, file, args);
    it("install → upgrade → rollback → uninstall preserves separate user data and keeps two versions", async () => {
      const s = await sandbox();
      try {
        for (const version of ["0.2.0", "0.2.1", "0.2.2"]) {
          const pkg = await pack(s.dir, version); await writeFile(path.join(s.config, "codes.json"), "[0]");
          const result = execute(shell, path.join(pkg, "install.ps1"), [...s.args, "-TestDefaultCwd", s.cwd, "-TestExecutor", s.executor, "-TestNode", process.execPath]);
          expect(result.code, result.output).toBe(0);
          expect((await readFile(path.join(s.install, "current.txt"), "utf8")).trim()).toBe(version);
          const config = await json(path.join(s.config, "config.json"));
          expect(config.codexExecutable).toBe(path.join(s.install, "versions", version, "codex", "codex.exe"));
          expect(config.defaultCwd).toBe(s.cwd);
          expect((await readdir(s.config)).filter(name => name.startsWith(".validate-"))).toEqual([]);
          expect(config.codexHome).toBe(path.join(s.config, "codex-home")); expect(config).not.toHaveProperty("agentKey");
          if (version === "0.2.0") { await mkdir(path.join(s.config, "codex-home")); await writeFile(path.join(s.config, "codex-home/auth.json"), "FAKE-AUTH-FIXTURE"); await mkdir(path.join(s.config, "logs"), { recursive: true }); await writeFile(path.join(s.config, "logs/keep.log"), "preserve"); }
          if (version === "0.2.0") {
            const same = execute(shell, path.join(pkg, "install.ps1"), [...s.args, "-TestDefaultCwd", s.cwd, "-TestExecutor", s.executor, "-TestNode", process.execPath]);
            expect(same.code, same.output).not.toBe(0);
            await writeFile(path.join(s.config, "codes.json"), "[0]");
            const overwrite = execute(shell, path.join(pkg, "install.ps1"), [...s.args, "-TestDefaultCwd", s.cwd, "-TestExecutor", s.executor, "-TestNode", process.execPath, "-TestOverwrite"]);
            expect(overwrite.code, overwrite.output).toBe(0);
          }
        }
        expect((await readdir(path.join(s.install, "versions"))).sort()).toEqual(["0.2.1", "0.2.2"]);
        await writeFile(path.join(s.config, "codes.json"), "[0]");
        const pkg = path.join(s.dir, "package-0.2.2");
        const rollback = execute(shell, path.join(pkg, "install.ps1"), [...s.args, "-Rollback", "-TestExecutor", s.executor, "-TestNode", process.execPath]);
        expect(rollback.code, rollback.output).toBe(0);
        expect((await readFile(path.join(s.install, "current.txt"), "utf8")).trim()).toBe("0.2.1");
        expect((await json(path.join(s.config, "config.json"))).runtimeDir).toBe(path.join(s.install, "versions/0.2.1/member-agent/runtime"));
        const uninstall = execute(shell, path.join(s.install, "uninstall.ps1"), s.args);
        expect(uninstall.code, uninstall.output).toBe(0);
        expect(await exists(path.join(s.install, "current.txt"))).toBe(false);
        expect(await exists(path.join(s.config, "config.json"))).toBe(true);
        expect(await exists(path.join(s.config, "agent-key.dpapi"))).toBe(true);
        expect(await exists(path.join(s.config, "codex-home/auth.json"))).toBe(true);
        expect(await exists(path.join(s.config, "logs/keep.log"))).toBe(true);
        for (const [option, removed, retained] of [
          ["-RemoveConfig", "config.json", "codex-home/auth.json"],
          ["-RemoveHome", "codex-home/auth.json", "logs/keep.log"],
          ["-RemoveLogs", "logs/keep.log", ""],
        ]) {
          const result = execute(shell, path.join(root, "uninstall.ps1"), [...s.args, option]);
          expect(result.code, result.output).toBe(0); expect(await exists(path.join(s.config, removed))).toBe(false);
          if (retained) expect(await exists(path.join(s.config, retained))).toBe(true);
        }
        expect(await exists(path.join(s.config, "agent-key.dpapi"))).toBe(false);
      } finally { await rm(s.dir, { recursive: true, force: true }); }
    }, 90_000);
    it("validates via a BOM-free temporary config file, tolerates a defensive BOM and removes validation files on success and failure", async () => {
      const s = await sandbox(); try {
        const pkg = await pack(s.dir, "0.2.0");
        const configModule = path.join(pkg, "app/member-agent/src/config.ts");
        const source = await readFile(configModule, "utf8");
        // Observe the actual validation boundary, then simulate a defensive BOM.
        const guard = `import fsFixture from 'node:fs';const inputFixture=process.env.PAPERCLIP_INSTALL_VALIDATE_CONFIG;
if(!inputFixture)throw new Error('CONFIG_FILE_ENV_MISSING');
const bytesFixture=fsFixture.readFileSync(inputFixture);if(bytesFixture.subarray(0,3).equals(Buffer.from([239,187,191])))throw new Error('CONFIG_FILE_HAS_BOM');
fsFixture.writeFileSync(inputFixture,'\\uFEFF'+bytesFixture.toString('utf8'));
`;
        await writeFile(configModule, guard + source); await manifest(pkg, "0.2.0");
        await writeFile(path.join(s.config, "codes.json"), "[0]");
        const args = [...s.args, "-TestDefaultCwd", s.cwd, "-TestExecutor", s.executor, "-TestNode", process.execPath];
        const installed = execute(shell, path.join(pkg, "install.ps1"), args);
        expect(installed.code, installed.output).toBe(0);
        expect((await json(path.join(s.config, "config.json"))).defaultCwd).toBe(s.cwd);
        expect((await readdir(s.config)).filter(name => name.startsWith(".validate-"))).toEqual([]);
        await writeFile(path.join(s.config, "config.json"), "{invalid fixture");
        const rejected = execute(shell, path.join(pkg, "install.ps1"), [...args, "-TestOverwrite", "-TestReplaceConfig", "-TestServerUrl", "http://8.8.8.8"]);
        expect(rejected.code, rejected.output).not.toBe(0);
        expect((await readdir(s.config)).filter(name => name.startsWith(".validate-"))).toEqual([]);
      } finally { await rm(s.dir, { recursive: true, force: true }); }
    }, 60_000);
    it("rejects manifest corruption, missing entries, traversal, public plaintext URL and incomplete test isolation", async () => {
      const s = await sandbox(); try {
        const pkg = await pack(s.dir, "0.2.0"), file = path.join(pkg, "install.ps1");
        const run = (extra: string[] = []) => execute(shell, file, [...s.args, "-TestDefaultCwd", s.cwd, "-TestNode", process.execPath, "-TestExecutor", s.executor, ...extra]);
        await writeFile(path.join(pkg, "app/codex/codex.exe"), "TAMPER"); expect(run().code).not.toBe(0);
        await manifest(pkg, "0.2.0"); const m = await json(path.join(pkg, "MANIFEST.json")); m.files.push({ path: "../escape", size: 0, sha256: "0".repeat(64) }); await writeFile(path.join(pkg, "MANIFEST.json"), JSON.stringify(m)); expect(run().code).not.toBe(0);
        await manifest(pkg, "0.2.0"); const missing = await json(path.join(pkg, "MANIFEST.json")); missing.files.pop(); await writeFile(path.join(pkg, "MANIFEST.json"), JSON.stringify(missing)); expect(run().code).not.toBe(0);
        await manifest(pkg, "0.2.0"); await writeFile(path.join(pkg, "unlisted.txt"), "unlisted"); expect(run().code).not.toBe(0); await rm(path.join(pkg, "unlisted.txt"));
        expect(run(["-TestServerUrl", "http://8.8.8.8"]).code).not.toBe(0);
        expect(await exists(path.join(s.config, "config.json"))).toBe(false);
        expect(execute(shell, file, ["-TestMode"]).code).not.toBe(0);
        expect(execute(shell, file, ["-TestMode", "-InstallRoot", s.install]).code).not.toBe(0);
      } finally { await rm(s.dir, { recursive: true, force: true }); }
    }, 60_000);
    it("keeps an installed same version intact on validation failure and can replace an invalid saved configuration", async () => {
      const s = await sandbox(); try {
        const pkg = await pack(s.dir, "0.2.0"), args = [...s.args, "-TestDefaultCwd", s.cwd, "-TestExecutor", s.executor, "-TestNode", process.execPath];
        await writeFile(path.join(s.config, "codes.json"), "[0]"); const first = execute(shell, path.join(pkg, "install.ps1"), args); expect(first.code, first.output).toBe(0);
        const executable = path.join(s.install, "versions/0.2.0/codex/codex.exe"); await writeFile(executable, "EXISTING-RELEASE-MUST-SURVIVE");
        const saved = await json(path.join(s.config, "config.json")); saved.defaultCwd = path.join(s.dir, "deleted-workspace"); await writeFile(path.join(s.config, "config.json"), JSON.stringify(saved));
        const rejected = execute(shell, path.join(pkg, "install.ps1"), [...args, "-TestOverwrite"]); expect(rejected.code, rejected.output).not.toBe(0);
        expect(await readFile(executable, "utf8")).toBe("EXISTING-RELEASE-MUST-SURVIVE"); expect((await readFile(path.join(s.install, "current.txt"), "utf8")).trim()).toBe("0.2.0");
        await writeFile(path.join(s.config, "config.json"), "{invalid old configuration"); await writeFile(path.join(s.config, "codes.json"), "[0]");
        const repaired = execute(shell, path.join(pkg, "install.ps1"), [...args, "-TestOverwrite", "-TestReplaceConfig"]); expect(repaired.code, repaired.output).toBe(0);
        expect((await json(path.join(s.config, "config.json"))).defaultCwd).toBe(s.cwd);
        expect(await readFile(path.join(s.config, "agent-key.dpapi"), "utf8")).toBe("FAKE-DPAPI-TEST-NOT-A-CREDENTIAL");
      } finally { await rm(s.dir, { recursive: true, force: true }); }
    }, 60_000);
    it("refuses reparse-point traversal before uninstalling and refuses an unowned process control record before overwrite", async () => {
      const s = await sandbox(); try {
        const outside = path.join(s.dir, "outside"); await mkdir(outside); await writeFile(path.join(outside, "keep.txt"), "keep");
        await mkdir(s.install); const link = path.join(s.install, "junction"); await symlink(outside, link, "junction");
        const blocked = execute(shell, path.join(root, "uninstall.ps1"), s.args);
        expect(blocked.code, blocked.output).not.toBe(0); expect(await readFile(path.join(outside, "keep.txt"), "utf8")).toBe("keep");
        await rm(link);
        const pkg = await pack(s.dir, "0.2.0"); const args = [...s.args, "-TestDefaultCwd", s.cwd, "-TestExecutor", s.executor, "-TestNode", process.execPath];
        await writeFile(path.join(s.config, "codes.json"), "[0]"); const installed = execute(shell, path.join(pkg, "install.ps1"), args); expect(installed.code, installed.output).toBe(0);
        const executable = path.join(s.install, "versions/0.2.0/codex/codex.exe");
        await writeFile(executable, "EXISTING-DO-NOT-OVERWRITE");
        await writeFile(path.join(s.config, "agent-control.json"), JSON.stringify({ pid: process.pid, startedAt: "2000-01-01T00:00:00.000Z" }));
        const overwrite = execute(shell, path.join(pkg, "install.ps1"), [...args, "-TestOverwrite"]);
        expect(overwrite.code, overwrite.output).not.toBe(0); expect(await readFile(executable, "utf8")).toBe("EXISTING-DO-NOT-OVERWRITE");
      } finally { await rm(s.dir, { recursive: true, force: true }); }
    }, 60_000);
    it("drains only the owned temporary installed agent before upgrading and ignores an exited stale owner", async () => {
      const s = await sandbox(); let child: ReturnType<typeof spawn> | undefined;
      try {
        const first = await pack(s.dir, "0.2.0"), second = await pack(s.dir, "0.2.1");
        const args = [...s.args, "-TestDefaultCwd", s.cwd, "-TestExecutor", s.executor, "-TestNode", process.execPath];
        await writeFile(path.join(s.config, "codes.json"), "[0]"); const installed = execute(shell, path.join(first, "install.ps1"), args); expect(installed.code, installed.output).toBe(0);
        const versionRoot = path.join(s.install, "versions/0.2.0"), executable = path.join(versionRoot, "node/node.exe"), main = path.join(versionRoot, "member-agent/src/main.ts");
        await cp(process.execPath, executable);
        await writeFile(main, `import fs from 'node:fs';import path from 'node:path';const dir=path.dirname(process.argv[process.argv.indexOf('--config')+1]);const identity={pid:process.pid,startedAt:new Date(Date.now()-process.uptime()*1000).toISOString()};fs.writeFileSync(path.join(dir,'agent-control.json'),JSON.stringify(identity));const busyUntil=Date.now()+4000;const timer=setInterval(()=>{try{const request=JSON.parse(fs.readFileSync(path.join(dir,'launcher-stop.request'),'utf8'));if(request.pid!==identity.pid||request.startedAt!==identity.startedAt)return;fs.writeFileSync(path.join(dir,'drain-observed.txt'),'draining');if(Date.now()<busyUntil)return;fs.writeFileSync(path.join(dir,'job-finished.txt'),'finished before stop');fs.unlinkSync(path.join(dir,'agent-control.json'));clearInterval(timer);process.exitCode=0}catch{}},20);`);
        child = spawn(executable, [main, "run", "--config", path.join(s.config, "config.json")], { stdio: "ignore", env: { APPDATA: s.dir, SYSTEMROOT: process.env.SYSTEMROOT, PATH: process.env.PATH } });
        const exited = once(child, "exit");
        for (let i = 0; i < 100 && !await exists(path.join(s.config, "agent-control.json")); i++) await new Promise(resolve => setTimeout(resolve, 20));
        expect(await exists(path.join(s.config, "agent-control.json"))).toBe(true);
        const identity = await json(path.join(s.config, "agent-control.json"));
        const inspect = spawnSync(shell, ["-NoProfile", "-Command", `Get-CimInstance Win32_Process -Filter 'ProcessId = ${child.pid}' | Select-Object ExecutablePath,CommandLine,CreationDate | ConvertTo-Json -Compress`], { encoding: "utf8" });
        await writeFile(path.join(s.config, "codes.json"), "[0]"); const upgraded = execute(shell, path.join(second, "install.ps1"), args);
        expect(upgraded.code, upgraded.output + "\nIDENTITY " + JSON.stringify(identity) + "\nCIM " + inspect.stdout + inspect.stderr).toBe(0); expect(await readFile(path.join(s.config, "job-finished.txt"), "utf8")).toBe("finished before stop");
        expect(await readFile(path.join(s.config, "drain-observed.txt"), "utf8")).toBe("draining");
        expect((await exited)[0]).toBe(0);
        await writeFile(path.join(s.config, "agent-control.json"), JSON.stringify({ pid: child.pid, startedAt: "2000-01-01T00:00:00.000Z" }));
        const removed = execute(shell, path.join(root, "uninstall.ps1"), s.args); expect(removed.code, removed.output).toBe(0);
        expect(await exists(path.join(s.config, "agent-control.json"))).toBe(false);
      } finally { if (child?.exitCode === null) child.kill(); await rm(s.dir, { recursive: true, force: true }); }
    }, 60_000);
    it("returns terminal run/check exit codes and retries crashes/unexpected codes at 10,30,60,300,300 seconds", async () => {
      const s = await sandbox(); try {
        const versionRoot = path.join(s.install, "versions/0.2.0"); await mkdir(versionRoot, { recursive: true }); await writeFile(path.join(s.install, "current.txt"), "0.2.0");
        await writeFile(path.join(s.config, "config.json"), "{}"); await writeFile(path.join(s.config, "agent-key.dpapi"), "FAKE-DPAPI-TEST-NOT-A-CREDENTIAL");
        const run = (mode: string) => execute(shell, path.join(root, "start.ps1"), [...s.args, "-Mode", mode, "-TestExecutor", s.executor, "-TestWait", s.wait]);
        for (const code of [0, 2, 3, 4, 5]) { await writeFile(path.join(s.config, "codes.json"), JSON.stringify([code])); const result = run("run"); expect(result.code, result.output).toBe(code); expect(await json(path.join(s.config, "codes.json"))).toEqual([]); }
        await writeFile(path.join(s.config, "codes.json"), '[1,99,"crash",1,1,0]'); const retry = run("run"); expect(retry.code, retry.output).toBe(0);
        expect((await readFile(path.join(s.config, "waits.txt"), "utf8")).trim().split(/\r?\n/).map(Number)).toEqual([10,30,60,300,300]);
        await writeFile(path.join(s.config, "codes.json"), "[1,0]"); const check = run("check"); expect(check.code, check.output).toBe(1); expect(await json(path.join(s.config, "codes.json"))).toEqual([0]);
      } finally { await rm(s.dir, { recursive: true, force: true }); }
    }, 90_000);
  });
});
