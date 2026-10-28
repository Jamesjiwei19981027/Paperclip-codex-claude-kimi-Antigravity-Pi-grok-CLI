import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = process.env.PMA_LAN_INSTALLER_ROOT ?? fileURLToPath(new URL("../installer/", import.meta.url));
const ps51 = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
const shells = [ps51, "pwsh.exe"];
const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
const bom = (file: string, text: string) => writeFile(file, "\uFEFF" + text, "utf8");
function run(shell: string, code: string) {
  const encoded = Buffer.from("$ErrorActionPreference='Stop';" + code, "utf16le").toString("base64");
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === "psmodulepath") delete env[key];
  const result = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], { encoding: "utf8", timeout: 30_000, windowsHide: true, env });
  return { code: result.status, output: result.stdout + result.stderr };
}
async function sandbox() {
  const dir = await mkdtemp(path.join(tmpdir(), "paperclip-lan-中文 空格-"));
  const install = path.join(dir, "程序"), config = path.join(dir, "配置");
  await mkdir(path.join(install, "versions/0.2.1"), { recursive: true });
  await mkdir(config);
  await writeFile(path.join(install, "current.txt"), "0.2.1");
  await writeFile(path.join(config, "config.json"), "{}");
  await writeFile(path.join(config, "agent-key.dpapi"), "FAKE-DPAPI-TEST-NOT-A-CREDENTIAL");
  const executor = path.join(dir, "executor.ps1");
  await bom(executor, `param($Mode,$ConfigPath,$VersionRoot)
$d=Split-Path $ConfigPath
[IO.File]::AppendAllText((Join-Path $d 'calls.txt'),$Mode+[Environment]::NewLine)
return [int](Get-Content -LiteralPath (Join-Path $d 'code.txt') -Raw)
`);
  await writeFile(path.join(config, "code.txt"), "0");
  const invoke = (extra = "") => `& ${quote(path.join(root, "start.ps1"))} -TestMode -InstallRoot ${quote(install)} -ConfigDir ${quote(config)} -TestExecutor ${quote(executor)} ${extra}; exit $LASTEXITCODE`;
  const calls = async () => (await readFile(path.join(config, "calls.txt"), "utf8").catch(() => "")).trim().split(/\r?\n/).filter(Boolean);
  return { dir, install, config, executor, invoke, calls };
}

describe.skipIf(process.platform !== "win32")("LAN installer regressions", () => {
  for (const shell of shells) {
    const available = process.platform === "win32" && spawnSync(shell, ["-NoProfile", "-Command", "exit 0"], { windowsHide: true }).status === 0;
    describe.skipIf(!available)(shell, () => {
      it("protects a real directory and file three times without SeSecurityPrivilege or ACL drift", async () => {
        const dir = await mkdtemp(path.join(tmpdir(), "paperclip-real-acl-"));
        try {
          const result = run(shell, `. ${quote(path.join(root, "uninstall.ps1"))} -Library
$d=${quote(dir)}; $f=Join-Path $d 'key.txt'; [IO.File]::WriteAllText($f,'not a credential')
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
foreach($entry in @(@{Path=$d;Directory=$true},@{Path=$f;Directory=$false})) {
  $first=$null
  for($i=0;$i -lt 3;$i++) {
    Protect-MemberPath $entry.Path $entry.Directory
    $acl=Get-Acl -LiteralPath $entry.Path
    $sddl=$acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]'Owner,Group,Access')
    if($first -and $first -ne $sddl){throw 'ACL changed'}; $first=$sddl
    if(!$acl.AreAccessRulesProtected -or @($acl.Access).Count -ne 1 -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid){throw 'ACL not private'}
    $rule=@($acl.Access)[0]
    if($rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $sid -or $rule.AccessControlType -ne 'Allow' -or $rule.FileSystemRights -ne 'FullControl'){throw 'incorrect private rule'}
  }
}
Write-Output 'real ACL directory=3 file=3 unchanged'
`);
          expect(result.code, result.output).toBe(0);
          expect(result.output).toContain("real ACL directory=3 file=3 unchanged");
        } finally { await rm(dir, { recursive: true, force: true }); }
      });

      it.each([2, 3, 4, 5])("suppresses unchanged terminal exit %i, then recovers after config and Key edits", async code => {
        const s = await sandbox();
        try {
          await writeFile(path.join(s.config, "code.txt"), String(code));
          const first = run(shell, s.invoke()); expect(first.code, first.output).toBe(code);
          expect(await s.calls()).toHaveLength(1);
          const blocked = run(shell, s.invoke("-LaunchReason Scheduled")); expect(blocked.code, blocked.output).toBe(0);
          expect(await s.calls()).toHaveLength(1);
          const manual = run(shell, s.invoke()); expect(manual.code, manual.output).toBe(0);
          expect(await s.calls()).toHaveLength(1);
          await writeFile(path.join(s.config, "config.json"), '{"edited":true}');
          const recovered = run(shell, s.invoke("-LaunchReason Scheduled")); expect(recovered.code, recovered.output).toBe(code);
          expect(await s.calls()).toHaveLength(2);
          await writeFile(path.join(s.config, "agent-key.dpapi"), "FAKE-DPAPI-TEST-NOT-A-CREDENTIAL\n");
          const keyRecovered = run(shell, s.invoke("-LaunchReason Scheduled")); expect(keyRecovered.code, keyRecovered.output).toBe(code);
          expect(await s.calls()).toHaveLength(3);
          expect(JSON.parse(await readFile(path.join(s.config, "launcher-stopped.json"), "utf8")).exitCode).toBe(code);
        } finally { await rm(s.dir, { recursive: true, force: true }); }
      }, 60_000);

      it("keeps normal stops stopped for watchdog ticks but allows a new logon or manual launch", async () => {
        const s = await sandbox();
        try {
          const invoke = (reason: string, id: string) => run(shell, s.invoke(`-LaunchReason ${reason} -TestLogonId ${id}`));
          expect(invoke("Scheduled", "session1").code).toBe(0);
          expect(invoke("Scheduled", "session1").code).toBe(0);
          expect(await s.calls()).toHaveLength(1);
          await writeFile(path.join(s.config, "config.json"), '{"edited":true}');
          expect(invoke("Scheduled", "session1").code).toBe(0);
          expect(await s.calls()).toHaveLength(1);
          expect(invoke("Scheduled", "session2").code).toBe(0);
          expect(await s.calls()).toHaveLength(2);
          expect(invoke("Manual", "session2").code).toBe(0);
          expect(await s.calls()).toHaveLength(3);
        } finally { await rm(s.dir, { recursive: true, force: true }); }
      }, 60_000);

      it.each(["config.json", "agent-key.dpapi"])("recovers if %s is repaired while a terminal attempt is still exiting", async name => {
        const s = await sandbox();
        try {
          const originalExecutor = await readFile(s.executor, "utf8");
          await bom(s.executor, `param($Mode,$ConfigPath,$VersionRoot)
$d=Split-Path $ConfigPath
[IO.File]::AppendAllText((Join-Path $d 'calls.txt'),'run'+[Environment]::NewLine)
[IO.File]::AppendAllText((Join-Path $d '${name}'),' ')
return 2
`);
          const first = run(shell, s.invoke()); expect(first.code, first.output).toBe(2);
          await writeFile(s.executor, originalExecutor);
          const fixed = run(shell, s.invoke("-LaunchReason Scheduled")); expect(fixed.code, fixed.output).toBe(0);
          expect(await s.calls()).toHaveLength(2);
        } finally { await rm(s.dir, { recursive: true, force: true }); }
      });

      it("does not launch during maintenance, or after the installation was removed", async () => {
        const s = await sandbox();
        try {
          await writeFile(path.join(s.install, "maintenance.flag"), "upgrade/rollback/uninstall");
          const held = run(shell, s.invoke("-LaunchReason Scheduled")); expect(held.code, held.output).toBe(0);
          expect(await s.calls()).toHaveLength(0);
          for (const mode of ["check", "login"]) {
            const interactive = run(shell, s.invoke(`-Mode ${mode}`)); expect(interactive.code, interactive.output).toBe(0);
          }
          expect(await s.calls()).toEqual(["check", "login"]);
          await rm(s.install, { recursive: true, force: true });
          const gone = run(shell, s.invoke("-LaunchReason Scheduled")); expect(gone.code, gone.output).toBe(0);
          expect(await s.calls()).toEqual(["check", "login"]);
        } finally { await rm(s.dir, { recursive: true, force: true }); }
      });

      it("disables the real task boundary before stopping the supervisor", async () => {
        const s = await sandbox();
        try {
          const result = run(shell, `. ${quote(path.join(root, "uninstall.ps1"))} -Library
$global:events=@()
function Get-ScheduledTask { param($TaskName,$ErrorAction) return @{TaskName=$TaskName} }
function Disable-ScheduledTask { param($TaskName,$ErrorAction) $global:events+='disable' }
function Stop-ScheduledTask { param($TaskName,$ErrorAction) $global:events+='stop' }
Stop-MemberAgent ${quote(s.install)} ${quote(s.config)} $false
if(($global:events -join ',') -ne 'disable,stop'){throw ('Wrong order: '+($global:events -join ','))}
if(!(Test-Path -LiteralPath ${quote(path.join(s.install, "maintenance.flag"))})){throw 'No maintenance fence'}
`);
          expect(result.code, result.output).toBe(0);
        } finally { await rm(s.dir, { recursive: true, force: true }); }
      });

      it("registers logon plus five-minute watchdog with limited interactive rights and IgnoreNew", async () => {
        const dir = await mkdtemp(path.join(tmpdir(), "paperclip-task-boundary-"));
        try {
          const result = run(shell, `$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile(${quote(path.join(root, "install.ps1"))},[ref]$tokens,[ref]$errors)
$fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Register-MemberTask'},$true)
Invoke-Expression $fn.Extent.Text
$TestMode=$false; $InstallRoot=${quote(dir)}
function New-ScheduledTaskAction { param($Execute,$Argument) if($Argument -notlike '*-LaunchReason Scheduled*' -or $Argument -notlike ('*'+$InstallRoot+'\\start.ps1*')){throw 'Not stable scheduled launcher'}; return @{} }
function New-ScheduledTaskTrigger { param([switch]$AtLogOn,$User,[switch]$Once,$At,$RepetitionInterval) if($AtLogOn){return 'logon'}; if(!$Once -or $RepetitionInterval.TotalMinutes -ne 5){throw 'Not five minute watchdog'}; return 'watchdog' }
function New-ScheduledTaskSettingsSet { param([switch]$AllowStartIfOnBatteries,[switch]$DontStopIfGoingOnBatteries,$ExecutionTimeLimit,$MultipleInstances) if($MultipleInstances -ne 'IgnoreNew' -or $ExecutionTimeLimit -ne [TimeSpan]::Zero){throw 'Wrong settings'}; return @{} }
function New-ScheduledTaskPrincipal { param($UserId,$LogonType,$RunLevel) if($LogonType -ne 'Interactive' -or $RunLevel -ne 'Limited'){throw 'Not unprivileged'};return @{} }
function Register-ScheduledTask { param($TaskName,$Action,$Trigger,$Settings,$Principal,[switch]$Force) if(($Trigger -join ',') -ne 'logon,watchdog'){throw 'Missing trigger'}; $global:registered=$true }
if(!(Register-MemberTask 'unused') -or !$global:registered){throw 'Task registration failed'}
`);
          expect(result.code, result.output).toBe(0);
        } finally { await rm(dir, { recursive: true, force: true }); }
      });

      it("unregisters the disabled task before uninstall removes program files", async () => {
        const s = await sandbox();
        try {
          const result = run(shell, `$env:LOCALAPPDATA=${quote(s.dir)}; $env:APPDATA=${quote(s.dir)}
$r=Join-Path $env:LOCALAPPDATA 'Programs\\PaperclipMemberAgent'; $c=Join-Path $env:APPDATA 'paperclip-member-agent'
[void][IO.Directory]::CreateDirectory((Split-Path $r))
Move-Item -LiteralPath ${quote(s.install)} -Destination $r
Move-Item -LiteralPath ${quote(s.config)} -Destination $c
$global:events=@()
function Read-Host { param($Prompt) if($Prompt -like '*确认卸载*'){return 'y'}; return 'n' }
function Get-ScheduledTask { param($TaskName,$ErrorAction) return @{TaskName=$TaskName} }
function Disable-ScheduledTask { param($TaskName,$ErrorAction) $global:events+='disable' }
function Stop-ScheduledTask { param($TaskName,$ErrorAction) $global:events+='stop' }
function Unregister-ScheduledTask { param($TaskName,$Confirm) if(!(Test-Path -LiteralPath $r)){throw 'Program deleted before task'}; $global:events+='unregister' }
& ${quote(path.join(root, "uninstall.ps1"))}
if($LASTEXITCODE -ne 0 -or ($global:events -join ',') -ne 'disable,stop,unregister' -or (Test-Path -LiteralPath $r)){throw 'Unsafe uninstall lifecycle'}
`);
          expect(result.code, result.output).toBe(0);
        } finally { await rm(s.dir, { recursive: true, force: true }); }
      });

      it("restores encoding after the installer native validator reports Chinese errors at code page 936", async () => {
        const s = await sandbox();
        try {
          const versionRoot = path.join(s.install, "versions/0.2.1");
          await mkdir(path.join(versionRoot, "member-agent/src"), { recursive: true });
          for (const name of ["config.ts", "transport-check.ts", "logger.ts"]) {
            await copyFile(new URL(`../src/${name}`, import.meta.url), path.join(versionRoot, "member-agent/src", name));
          }
          const savedPath = path.join(s.dir, "validator-encoding.json");
          const result = run(shell, `. ${quote(path.join(root, "uninstall.ps1"))} -Library
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile(${quote(path.join(root, "install.ps1"))},[ref]$tokens,[ref]$errors)
$fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Test-MemberConfiguration'},$true)
Invoke-Expression $fn.Extent.Text
$TestMode=$true;$TestNode=${quote(process.execPath)};$ConfigDir=${quote(s.config)}
[Console]::OutputEncoding=[Text.Encoding]::GetEncoding(936)
$captured=& { try { Test-MemberConfiguration ([PSCustomObject]@{defaultCwd=${quote(s.dir)};serverUrl='http://public.example.com';executor='codex';projectDirs=@{}}) ${quote(versionRoot)} } catch { Write-Output $_.ToString() } } 2>&1
$saved=@{text=($captured -join [Environment]::NewLine);codepage=[Console]::OutputEncoding.CodePage}
[IO.File]::WriteAllText(${quote(savedPath)},($saved|ConvertTo-Json),(New-Object Text.UTF8Encoding($false)))
`);
          expect(result.code, result.output).toBe(0);
          const saved = JSON.parse(await readFile(savedPath, "utf8"));
          expect(saved.text).toContain("配置校验失败：请检查服务器纯源地址、内网明文限制和目录设置。");
          expect(saved.codepage).toBe(936);
        } finally { await rm(s.dir, { recursive: true, force: true }); }
      });

      it.each(["login", "check"])("decodes native Chinese in %s at code page 936 and restores console encoding", async mode => {
        const s = await sandbox();
        try {
          const versionRoot = path.join(s.install, "versions/0.2.1");
          await mkdir(path.join(versionRoot, "node")); await mkdir(path.join(versionRoot, "member-agent/src"), { recursive: true });
          await copyFile(process.execPath, path.join(versionRoot, "node/node.exe"));
          await writeFile(path.join(versionRoot, "member-agent/src/main.ts"), 'console.log("中文自检与登录输出");');
          const local = path.join(s.dir, "local"), app = path.join(s.dir, "app");
          await mkdir(path.join(local, "Programs"), { recursive: true }); await mkdir(app);
          // Point production defaults at the isolated temporary installation, not the real profile.
          const resultPath = path.join(s.dir, "encoding.json");
          const wrapper = path.join(s.dir, "encoding.ps1");
          await bom(wrapper, `$ErrorActionPreference='Stop'
$env:LOCALAPPDATA=${quote(local)};$env:APPDATA=${quote(app)}
Move-Item -LiteralPath ${quote(s.install)} -Destination (Join-Path $env:LOCALAPPDATA 'Programs\\PaperclipMemberAgent')
Move-Item -LiteralPath ${quote(s.config)} -Destination (Join-Path $env:APPDATA 'paperclip-member-agent')
$c=Join-Path $env:APPDATA 'paperclip-member-agent'
$encrypted='fake-key-not-a-credential' | ConvertTo-SecureString -AsPlainText -Force | ConvertFrom-SecureString
[IO.File]::WriteAllText((Join-Path $c 'agent-key.dpapi'),$encrypted)
[Console]::OutputEncoding=[Text.Encoding]::GetEncoding(936)
$text = & ${quote(path.join(root, "start.ps1"))} -Mode ${mode}
$saved=@{text=($text -join [Environment]::NewLine);codepage=[Console]::OutputEncoding.CodePage}
[IO.File]::WriteAllText(${quote(resultPath)},($saved|ConvertTo-Json),(New-Object Text.UTF8Encoding($false)))
`);
          const encoded = Buffer.from(`& ${quote(wrapper)}`, "utf16le").toString("base64");
          const env = { ...process.env };
          for (const key of Object.keys(env)) if (key.toLowerCase() === "psmodulepath") delete env[key];
          const result = spawnSync("cmd.exe", ["/d", "/s", "/c", `chcp 936 >nul && ${shell} -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`], { timeout: 30_000, windowsHide: true, env });
          expect(result.status, result.stdout?.toString() + result.stderr?.toString()).toBe(0);
          const saved = JSON.parse(await readFile(resultPath, "utf8"));
          expect(saved.text).toContain("中文自检与登录输出"); expect(saved.codepage).toBe(936);
          const logs = path.join(app, "paperclip-member-agent/logs");
          const today = new Date().toLocaleDateString("en-CA").replaceAll("-", "");
          expect(await readFile(path.join(logs, `launcher-${today}.log`), "utf8")).toContain(`模式 ${mode}，退出码 0`);
        } finally { await rm(s.dir, { recursive: true, force: true }); }
      });
    });
  }
});
