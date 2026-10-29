import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-ignore Standalone builder intentionally uses native JS.
import * as builder from "../scripts/build-installer.mjs";

const roots: string[] = [];
const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const integrity = "sha512-ccwSxOizTYO/e+dOidQTSEBcGQPMD0JvWxRn39/jNVo/cmO/1eVtVOk4fTvo0+HwJfgafmh8M4DEiXQeGnvlKA==";
async function sandbox() { const root = await fs.mkdtemp(path.join(tmpdir(), "codebuddy-installer-中文 空格-")); roots.push(root); return root; }
afterAll(async () => { for (const root of roots) await fs.rm(root, { recursive: true, force: true }); });

describe("CodeBuddy installer variant", () => {
  it("parses executor separately from paths and rejects unsupported variants", () => {
    expect(builder.parseArgs(["--executor", "codebuddy"]).executor).toBe("codebuddy");
    expect(builder.parseArgs([]).executor).toBe("codex");
    expect(() => builder.parseArgs(["--executor", "unexpected"])).toThrow(/executor|执行器/);
  });
  it("rejects a forged npm integrity before granting third party scan provenance", () => {
    const lock = { packages: { "node_modules/@tencent-ai/codebuddy-code": { version: "2.169.0", integrity: "sha512-invalid" } } };
    expect(() => builder.verifyCodeBuddyLock(lock)).toThrow(/integrity/);
    lock.packages["node_modules/@tencent-ai/codebuddy-code"].integrity = integrity;
    expect(() => builder.verifyCodeBuddyLock(lock)).not.toThrow();
  });
  it("rejects an untrusted CodeBuddy home even when its contents look harmless",async()=>{
    const root=await sandbox();await fs.mkdir(path.join(root,"codebuddy-home"));await fs.writeFile(path.join(root,"codebuddy-home","settings.txt"),"safe-looking personal settings");
    await expect(builder.scanInstaller(root)).rejects.toThrow(/禁止/);
  });
  it("archives a source file past the Windows legacy 260-character limit",async()=>{
    const root=await sandbox();const memberAgentDir=path.join(root,"member-agent");const out=path.join(memberAgentDir,"dist-installer");await fs.mkdir(out,{recursive:true});
    const packageDir=path.join(out,"package");const parent=path.join(packageDir,"p".repeat(240-packageDir.length-1));await fs.mkdir(parent,{recursive:true});
    const file=path.join(parent,"codebuddy-long-path-中文-"+"x".repeat(30)+".d.ts");await fs.writeFile(file,"long path content");expect(file.length).toBeGreaterThan(260);
    const zip=path.join(out,"long.zip");await builder.archiveInstaller(packageDir,zip,memberAgentDir);
    const command="Add-Type -AssemblyName System.IO.Compression.FileSystem;$z=[IO.Compression.ZipFile]::OpenRead($env:PMA_ZIP);try{$r=New-Object IO.StreamReader($z.Entries[0].Open());try{$r.ReadToEnd()}finally{$r.Dispose()}}finally{$z.Dispose()}";
    const result=spawnSync("powershell.exe",["-NoProfile","-NonInteractive","-Command",command],{encoding:"utf8",env:{...process.env,PMA_ZIP:zip}});expect(result.status,result.stderr).toBe(0);expect(result.stdout.trim()).toBe("long path content");
  });
  it.each(["powershell.exe","pwsh.exe"])("%s changes executor configuration to match staged files and rollback files with BOM-free Chinese paths",async shell=>{
    const root=await sandbox(); const configDir=path.join(root,"成员 配置"); const codex=path.join(root,"旧 Codex"); const buddy=path.join(root,"暂存 CodeBuddy"); const target=path.join(root,"新版本");
    await fs.mkdir(path.join(codex,"codex"),{recursive:true});await fs.mkdir(path.join(buddy,"codebuddy"),{recursive:true});await fs.mkdir(configDir);
    const script=path.join(root,"config-test.ps1");
    const installer=path.resolve(import.meta.dirname,"../installer/install.ps1");
    await fs.writeFile(script,'\uFEFF'+`$ErrorActionPreference='Stop'\n$ConfigDir=$env:PMA_CONFIG_DIR\n$tree=[System.Management.Automation.Language.Parser]::ParseFile($env:PMA_INSTALLER,[ref]$null,[ref]$null)\n$fn=$tree.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Set-ConfigPrograms'},$true)\nInvoke-Expression $fn.Extent.Text\n$c=[PSCustomObject]@{executor='codex';codexExecutable='old';codexHome='old';agentKey='FAKE-NOT-A-KEY';codebuddyModel='available-model'}\nSet-ConfigPrograms $c $env:PMA_TARGET $env:PMA_BUDDY\n[IO.File]::WriteAllText((Join-Path $ConfigDir 'buddy.json'),($c|ConvertTo-Json),(New-Object Text.UTF8Encoding($false)))\nSet-ConfigPrograms $c $env:PMA_CODEX\n[IO.File]::WriteAllText((Join-Path $ConfigDir 'codex.json'),($c|ConvertTo-Json),(New-Object Text.UTF8Encoding($false)))\n`);
    const result=spawnSync(shell,["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",script],{encoding:"utf8",env:{...process.env,PMA_CONFIG_DIR:configDir,PMA_TARGET:target,PMA_BUDDY:buddy,PMA_CODEX:codex,PMA_INSTALLER:installer}});
    expect(result.status,result.stdout+result.stderr).toBe(0);
    const bytes=await fs.readFile(path.join(configDir,"buddy.json"));expect(bytes[0]).not.toBe(239);
    const bc=JSON.parse(bytes.toString("utf8"));expect(bc.executor).toBe("codebuddy");expect(bc.codebuddyEntry).toBe(path.join(target,"codebuddy/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy"));expect(bc.codebuddyHome).toBe(path.join(configDir,"codebuddy-home"));expect(bc.codebuddyModel).toBe("available-model");expect(bc).not.toHaveProperty("codexExecutable");expect(bc).not.toHaveProperty("agentKey");
    const cc=JSON.parse(await fs.readFile(path.join(configDir,"codex.json"),"utf8"));expect(cc.executor).toBe("codex");expect(cc.codexExecutable).toBe(path.join(codex,"codex/codex.exe"));expect(cc).not.toHaveProperty("codebuddyEntry");expect(cc).not.toHaveProperty("codebuddyHome");
  });
  it.each(["powershell.exe","pwsh.exe"])("%s installs CodeBuddy and preserves same-version Codex rollback and package manifest",async shell=>{
    const root=await sandbox();const install=path.join(root,"程序");const config=path.join(root,"配置");const cwd=path.join(root,"项目");const pkg=path.join(root,"包");
    await fs.mkdir(config);await fs.mkdir(cwd);await fs.mkdir(pkg);const installer=path.resolve(import.meta.dirname,"../installer");
    for(const name of ["install.ps1","uninstall.ps1","README-成员安装说明.md"])await fs.copyFile(path.join(installer,name),path.join(pkg,name));
    const files:Record<string,string>={"app/start.ps1":await fs.readFile(path.join(installer,"start.ps1"),"utf8"),"app/node/node.exe":"FAKE-NOT-EXECUTABLE","app/member-agent/package.json":'{"type":"module"}',"app/member-agent/src/main.ts":"// fake main","app/member-agent/runtime/server/dist/claude-local.mjs":"// fake runtime","app/codebuddy/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy":"// fake CLI","app/codebuddy/package-lock.json":"{}"};
    for(const name of ["config.ts","logger.ts","transport-check.ts"])files[`app/member-agent/src/${name}`]=await fs.readFile(path.resolve(import.meta.dirname,"../src",name),"utf8");
    for(const [rel,text]of Object.entries(files)){await fs.mkdir(path.dirname(path.join(pkg,rel)),{recursive:true});await fs.writeFile(path.join(pkg,rel),text);}
    const rows=[];for(const rel of ["install.ps1","uninstall.ps1","README-成员安装说明.md",...Object.keys(files)]){const bytes=await fs.readFile(path.join(pkg,rel));rows.push({path:rel,size:bytes.length,sha256:digest(bytes)});}
    await fs.writeFile(path.join(pkg,"MANIFEST.json"),JSON.stringify({agentVersion:"0.3.2",nodeVersion:"24.18.0",executor:"codebuddy",codebuddyVersion:"2.169.0",runtimeManifest:{},builtAt:"test",repoCommit:"test",files:rows}));
    const old=path.join(install,"versions/0.3.2");await fs.mkdir(path.join(old,"codex"),{recursive:true});await fs.mkdir(path.join(old,"member-agent/src"),{recursive:true});
    await fs.copyFile(path.join(installer,"start.ps1"),path.join(old,"start.ps1"));for(const name of ["config.ts","logger.ts","transport-check.ts"])await fs.copyFile(path.resolve(import.meta.dirname,"../src",name),path.join(old,"member-agent/src",name));
    await fs.writeFile(path.join(old,"member-agent/package.json"),'{"type":"module"}');await fs.writeFile(path.join(install,"current.txt"),"0.3.2");
    await fs.writeFile(path.join(config,"config.json"),JSON.stringify({serverUrl:"http://localhost:39999",executor:"codex",defaultCwd:cwd,projectDirs:{},codexExecutable:path.join(old,"codex/codex.exe"),codexHome:path.join(config,"codex-home")}));await fs.writeFile(path.join(config,"agent-key.dpapi"),"FAKE-DPAPI-TEST-NOT-A-CREDENTIAL");
    const executor=path.join(root,"executor.ps1");await fs.writeFile(executor,"\uFEFFparam($Mode,$ConfigPath,$VersionRoot)\nreturn 0\n");
    const args=["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",path.join(pkg,"install.ps1"),"-TestMode","-InstallRoot",install,"-ConfigDir",config,"-TestExecutor",executor,"-TestNode",process.execPath];
    const run=(extra:string[]=[])=>spawnSync(shell,[...args,...extra],{encoding:"utf8",timeout:30_000,windowsHide:true});
    let r=run();expect(r.status,r.stdout+r.stderr).toBe(0);expect((await fs.readFile(path.join(install,"current.txt"),"utf8")).trim()).toBe("0.3.2-codebuddy");
    expect(JSON.parse(await fs.readFile(path.join(config,"config.json"),"utf8")).executor).toBe("codebuddy");expect(JSON.parse(await fs.readFile(path.join(install,"versions/0.3.2-codebuddy/PACKAGE-MANIFEST.json"),"utf8")).files).toHaveLength(rows.length);
    r=run(["-Rollback"]);expect(r.status,r.stdout+r.stderr).toBe(0);expect((await fs.readFile(path.join(install,"current.txt"),"utf8")).trim()).toBe("0.3.2");expect(JSON.parse(await fs.readFile(path.join(config,"config.json"),"utf8")).executor).toBe("codex");
  },60_000);
});

describe("verified CodeBuddy packaging", () => {
  let vendor: {directory:string; packageRoot:string; receipt:object};
  beforeAll(async () => {
    if (process.env.PMA_VERIFIED_CODEBUDDY_DIR) {
      vendor = await builder.reuseVerifiedCodeBuddy(process.env.PMA_VERIFIED_CODEBUDDY_DIR, process.env.PMA_VERIFIED_CODEBUDDY_MANIFEST, process.env.PMA_VERIFIED_CODEBUDDY_MANIFEST_SHA256);
    } else { vendor = await builder.installCodeBuddy(); roots.push(vendor.directory); }
  }, 180_000);
  it("rejects reuse when the independently approved manifest digest does not match", async () => {
    const root = await sandbox(), manifest = path.join(root, "manifest.json");
    await fs.writeFile(manifest, "{}");
    await expect(builder.reuseVerifiedCodeBuddy(root, manifest, "0".repeat(64))).rejects.toThrow(/SHA-256/);
  });
  it("rejects tampered files even when the approved manifest and npm integrity match", async () => {
    const root = await sandbox(), directory = path.join(root, "vendor"), manifest = path.join(root, "manifest.json");
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, "package-lock.json"), JSON.stringify({ packages: { "node_modules/@tencent-ai/codebuddy-code": { version: "2.169.0", integrity } } }));
    const approved = JSON.stringify({ executor: "codebuddy", codebuddyVersion: "2.169.0", codebuddyIntegrity: integrity, files: [
      { path: "app/codebuddy/package-lock.json", sha256: digest(await fs.readFile(path.join(directory, "package-lock.json"))) },
    ] });
    await fs.writeFile(manifest, approved);
    await fs.appendFile(path.join(directory, "package-lock.json"), " ");
    await expect(builder.reuseVerifiedCodeBuddy(directory, manifest, digest(approved))).rejects.toThrow(/哈希/);
  });
  async function fixture() {
    const root = await sandbox(); const memberAgentDir = path.join(root, "member-agent");
    const files: Record<string,string> = {
      "member-agent/package.json": '{"version":"0.3.2","type":"module"}',
      "member-agent/src/main.ts": "// main", "member-agent/src/codebuddy-cli.ts": "// codebuddy launcher",
      "member-agent/src/executors/codebuddy.ts": "// codebuddy executor", "member-agent/src/executors/codex.ts": "// codex executor",
      "member-agent/node_modules/ws/package.json": '{"name":"ws"}',
      "member-agent/runtime/MANIFEST.json": JSON.stringify({builtAt:"test",assets:{"server/dist/claude-local.mjs":digest("// claude")}}),
      "member-agent/runtime/server/dist/claude-local.mjs": "// claude",
      "member-agent/runtime/server/dist/codex-local.mjs": "// codex",
      "member-agent/installer/install.ps1": "# install", "member-agent/installer/uninstall.ps1": "# uninstall",
      "member-agent/installer/start.ps1": "# start", "member-agent/installer/README-成员安装说明.md": "说明",
      "node/LICENSE": "license",
    };
    for (const [rel, text] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(root,rel)),{recursive:true}); await fs.writeFile(path.join(root,rel),text); }
    await fs.copyFile(process.execPath,path.join(root,"node/node.exe"));
    return {memberAgentDir,nodeDirectory:path.join(root,"node"),outputDir:path.join(memberAgentDir,"dist-installer"),repoCommit:"fixture"};
  }
  it("ships a complete CodeBuddy variant without Codex binaries and hashes every vendor file", async () => {
    const f=await fixture(); const {packageDir,manifest}=await builder.assembleInstaller({...f,executor:"codebuddy",codebuddy:vendor});
    expect(path.basename(packageDir)).toBe("PaperclipMemberAgent-0.3.2-codebuddy");
    expect(manifest.executor).toBe("codebuddy"); expect(manifest.codebuddyVersion).toBe("2.169.0");
    expect(manifest).not.toHaveProperty("codexVersion");
    expect(manifest.files.some((file:{path:string})=>file.path.startsWith("app/codex/"))).toBe(false);
    expect(manifest.files.some((file:{path:string})=>file.path.endsWith("/bin/codebuddy"))).toBe(true);
    for(const file of manifest.files) expect(digest(await fs.readFile(path.join(packageDir,file.path)))).toBe(file.sha256);
    await expect(builder.scanInstaller(packageDir,vendor.receipt)).resolves.toBeDefined();
    const entry=path.join(packageDir,"app/codebuddy/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy");
    await fs.appendFile(entry,"// unexpected user file modification");
    await expect(builder.scanInstaller(packageDir,vendor.receipt)).rejects.toThrow(/来源|哈希|第三方/);
  },60_000);
  it("rejects user files added under the trusted third party tree", async () => {
    const f=await fixture(); const {packageDir}=await builder.assembleInstaller({...f,executor:"codebuddy",codebuddy:vendor});
    await fs.writeFile(path.join(packageDir,"app/codebuddy/untrusted.js"),"// user content");
    await expect(builder.scanInstaller(packageDir,vendor.receipt)).rejects.toThrow(/来源|第三方/);
  },60_000);
  it("filters CodeBuddy sources and Claude bundle from the default Codex variant with a synchronized manifest",async()=>{
    const f=await fixture(); const codexDirectory=path.resolve(import.meta.dirname,"../../node_modules/.pnpm/@openai+codex@0.160.0-win32-x64/node_modules/@openai/codex/vendor/x86_64-pc-windows-msvc/bin");
    const {packageDir,manifest}=await builder.assembleInstaller({...f,codexDirectory});
    expect(path.basename(packageDir)).toBe("PaperclipMemberAgent-0.3.2");
    expect(manifest.files.some((file:{path:string})=>/codebuddy|claude-local/.test(file.path))).toBe(false);
    expect(manifest.runtimeManifest.assets).not.toHaveProperty("server/dist/claude-local.mjs");
    expect(JSON.parse(await fs.readFile(path.join(packageDir,"app/member-agent/runtime/MANIFEST.json"),"utf8"))).toEqual(manifest.runtimeManifest);
  },60_000);
});
