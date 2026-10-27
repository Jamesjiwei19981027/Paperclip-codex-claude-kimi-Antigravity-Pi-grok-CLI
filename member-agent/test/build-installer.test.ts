import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
// The JS builder is intentionally independent of the application's TS compile.
// @ts-ignore
import { archiveInstaller, assembleInstaller, assertSafeOutput, compareInstallers, scanInstaller, verifyNodeArchive, verifyPinnedBinary, NODE_VERSION, NODE_ARCHIVE, officialUrl } from "../scripts/build-installer.mjs";

const repo = path.resolve(import.meta.dirname, "../..");
const script = path.join(repo, "member-agent/scripts/build-installer.mjs");
const roots: string[] = [];
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
let officialNode: string;
const officialCodex = path.join(repo, "node_modules/.pnpm/@openai+codex@0.160.0-win32-x64/node_modules/@openai/codex/vendor/x86_64-pc-windows-msvc/bin");
const binaryPins: Record<string,string> = {
  "app/node/node.exe": "9a4eb5f1c29c6a2e93852ead46b999e284a6a5ca8bab4d4e241d587d025a52de",
  "app/codex/codex.exe": "fdda5fa3cf3fb3d000b876720742857676293e4315e4b045fae6f8bd7e866d1d",
  "app/codex/codex-code-mode-host.exe": "1d448bfde19e7a280d600d8d0bcddf77afbe9feaec1e804905becc5f39bc9db6",
};
beforeAll(async () => {
  // Use the current pinned Node binary, never a previous generated artifact.
  // The CLI separately fetches official SHASUMS and checks the extracted binary.
  expect(digest(await fs.readFile(process.execPath))).toBe(binaryPins["app/node/node.exe"]);
  officialNode = await fs.mkdtemp(path.join(tmpdir(),"member-installer-pinned-node-"));
  await fs.copyFile(process.execPath,path.join(officialNode,"node.exe"));
  await fs.writeFile(path.join(officialNode,"LICENSE"),"Fixture license for structural tests");
});
afterAll(async () => { if (officialNode) await fs.rm(officialNode,{recursive:true,force:true}); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(tmpdir(), "member-installer-")); roots.push(root);
  const memberAgentDir = path.join(root, "member-agent");
  const files: Record<string, string> = {
    "member-agent/src/main.ts": "console.log('safe source');\n",
    "member-agent/package.json": '{"name":"member-agent","version":"0.2.0","dependencies":{"ws":"8.22.0"}}',
    "member-agent/node_modules/ws/package.json": '{"name":"ws","version":"8.22.0"}',
    "member-agent/node_modules/ws/index.js": "export default class WebSocket {}",
    "member-agent/runtime/MANIFEST.json": '{"builtAt":"2026-01-01T00:00:00Z","bundleSha256":"fixture"}\n',
    "member-agent/runtime/server/dist/codex-local.mjs": "export function execute() {}",
    "member-agent/installer/install.ps1": "\uFEFF# install\n",
    "member-agent/installer/start.ps1": "\uFEFF# start\n",
    "member-agent/installer/uninstall.ps1": "\uFEFF# uninstall\n",
    "member-agent/installer/README-成员安装说明.md": "成员安装说明\n",
    "node/node.exe": "safe fake node executable",
    "node/LICENSE": "Node license",
    "codex/codex.exe": "safe fake codex executable",
    "codex/codex-code-mode-host.exe": "safe fake host executable",
  };
  for (const [rel, contents] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), contents);
  }
  return { root, memberAgentDir, nodeDirectory: officialNode, codexDirectory: officialCodex, repoCommit: "fixture-commit" };
}
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

describe("installer builder", () => {
  it("pins official Node URLs and validates even a supplied archive against SHA256", async () => {
    expect(NODE_VERSION).toBe("24.18.0");
    expect(officialUrl(NODE_ARCHIVE).href).toBe(`https://nodejs.org/dist/v24.18.0/${NODE_ARCHIVE}`);
    expect(() => officialUrl("https://mirror.invalid/node.zip")).toThrow(/nodejs.org/);
    const f = await fixture(); const zip = path.join(f.root, "node.zip"); await fs.writeFile(zip, "fixture zip bytes");
    await expect(verifyNodeArchive(zip, `${digest("fixture zip bytes")}  ${NODE_ARCHIVE}\n`)).resolves.toBe(digest("fixture zip bytes"));
    await expect(verifyNodeArchive(zip, `${"0".repeat(64)}  ${NODE_ARCHIVE}\n`)).rejects.toThrow(/SHA-256/);
    await expect(verifyNodeArchive(zip, `${digest("fixture zip bytes")}  another.zip\n`)).rejects.toThrow(/SHASUMS/);
  });

  it("stages only the specified layout, complete hashes and a verbatim runtime manifest", async () => {
    const f = await fixture(); const outputDir = path.join(f.memberAgentDir, "dist-installer/first");
    const { packageDir, manifest } = await assembleInstaller({ ...f, outputDir });
    expect(manifest).toEqual(expect.objectContaining({agentVersion: "0.2.0", nodeVersion: NODE_VERSION, codexVersion: "0.160.0", repoCommit: f.repoCommit, builtAt: expect.any(String)}));
    expect(manifest.runtimeManifest).toEqual(JSON.parse(await fs.readFile(path.join(f.memberAgentDir, "runtime/MANIFEST.json"), "utf8")));
    expect(await fs.readFile(path.join(packageDir, "app/member-agent/runtime/MANIFEST.json"), "utf8")).toBe(await fs.readFile(path.join(f.memberAgentDir, "runtime/MANIFEST.json"), "utf8"));
    const paths = manifest.files.map((file: {path: string}) => file.path);
    for (const rel of ["install.ps1", "uninstall.ps1", "README-成员安装说明.md", "app/start.ps1", "app/node/node.exe", "app/node/LICENSE", "app/member-agent/src/main.ts", "app/member-agent/package.json", "app/member-agent/node_modules/ws/package.json", "app/member-agent/runtime/MANIFEST.json", "app/codex/codex.exe", "app/codex/codex-code-mode-host.exe"]) expect(paths).toContain(rel);
    expect(paths).not.toContain("MANIFEST.json");
    for (const file of manifest.files) { const bytes = await fs.readFile(path.join(packageDir, file.path)); expect(file.size).toBe(bytes.length); expect(file.sha256).toBe(digest(bytes)); }
    const reports = await scanInstaller(packageDir);
    for (const [rel, pinnedSha256] of Object.entries(binaryPins)) {
      expect(manifest.files.find((file: {path:string}) => file.path === rel)).toEqual(expect.objectContaining({scanMethod:"哈希锁定，未做文本扫描", pinnedSha256}));
      expect(reports.find((file: {path:string}) => file.path === rel)).toEqual({path:rel, scanMethod:"哈希锁定，未做文本扫描", pinnedSha256});
    }
    expect(reports.filter((file: {scanMethod:string}) => file.scanMethod === "哈希锁定，未做文本扫描")).toHaveLength(3);
    expect((await fs.lstat(path.join(packageDir, "app/member-agent/node_modules/ws"))).isSymbolicLink()).toBe(false);
  });

  it("writes only forward-slash ZIP entries including Chinese names", async () => {
    const f = await fixture();
    const outputDir = path.join(f.memberAgentDir, "dist-installer/zip");
    // ZIP naming is independent of executable contents; keep this fixture small.
    const packageDir = path.join(outputDir, "package");
    await fs.mkdir(path.join(packageDir, "app/codex"), {recursive:true});
    await fs.writeFile(path.join(packageDir, "app/codex/codex-code-mode-host.exe"), "FAKE-NOT-EXECUTABLE");
    await fs.writeFile(path.join(packageDir, "README-成员安装说明.md"), "中文内容");
    const zip = path.join(outputDir, "fixture.zip");
    await archiveInstaller(packageDir, zip, f.memberAgentDir);
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip=[IO.Compression.ZipFile]::OpenRead($env:PMA_TEST_ZIP); try { $names=@($zip.Entries | ForEach-Object { $_.FullName }); [Console]::OutputEncoding=New-Object Text.UTF8Encoding($false); ConvertTo-Json -InputObject $names -Compress } finally { $zip.Dispose() }"], { encoding:"utf8", env:{...process.env,PMA_TEST_ZIP:zip}, windowsHide:true });
    expect(result.status, result.stderr).toBe(0);
    const entries = JSON.parse(result.stdout.replace(/^\uFEFF/, "")) as string[];
    expect(entries).toHaveLength(2);
    expect(entries.every(name => !name.includes("\\"))).toBe(true);
    expect(entries).toContain("app/codex/codex-code-mode-host.exe");
    expect(entries).toContain("README-成员安装说明.md");
  });

  it("compares two builds excluding precisely the two builtAt fields", async () => {
    const f = await fixture(); const first = await assembleInstaller({...f, outputDir: path.join(f.memberAgentDir, "dist-installer/first")});
    await fs.writeFile(path.join(f.memberAgentDir, "runtime/MANIFEST.json"), '{"builtAt":"2026-02-02T00:00:00Z","bundleSha256":"fixture"}\n');
    const second = await assembleInstaller({...f, outputDir: path.join(f.memberAgentDir, "dist-installer/second")});
    await expect(compareInstallers(first.packageDir, second.packageDir)).resolves.toBeUndefined();
    await fs.writeFile(path.join(f.memberAgentDir, "runtime/MANIFEST.json"), '{"builtAt":"2026-02-02T00:00:00Z","bundleSha256":"changed"}\n');
    const changed = await assembleInstaller({...f, outputDir: path.join(f.memberAgentDir, "dist-installer/changed")});
    await expect(compareInstallers(first.packageDir, changed.packageDir)).rejects.toThrow(/两次安装包内容不一致/);
  });

  it.each(["auth.json", "config.json", "unexpected.json", "test/fixture.ts", "codex-home/file", "agent.log"])("rejects forbidden artifact name %s", async (rel) => {
    const f = await fixture(); const bad = path.join(f.memberAgentDir, "runtime", rel); await fs.mkdir(path.dirname(bad), {recursive: true}); await fs.writeFile(bad, "safe");
    await expect(assembleInstaller({...f, outputDir: path.join(f.memberAgentDir, "dist-installer/bad")})).rejects.toThrow(/禁止|白名单/);
  });

  it.each(["pcp_", "pcp_fake_not_a_live_secret", "sk-abcdefghijklmnopqrstuvwxyz012345", "prefixsk-abcdefghijklmnopqrstuvwxyz012345", "-----BEGIN RSA PRIVATE KEY-----"])("scans every artifact including binary bytes: %s", async (secret) => {
    const f = await fixture(); const scanDir = path.join(f.root, "scan"); await fs.mkdir(scanDir); await fs.writeFile(path.join(scanDir,"untrusted.exe"), Buffer.concat([Buffer.from([0,255]), Buffer.from(secret), Buffer.from([0])]));
    await expect(scanInstaller(scanDir)).rejects.toThrow(/敏感内容/);
  });

  it("also scans UTF16LE secrets and the completed manifest", async () => {
    const f = await fixture(); const isolated = path.join(f.root, "utf16-scan-only"); await fs.mkdir(isolated);
    await fs.writeFile(path.join(isolated, "utf16.exe"), Buffer.from("pcp_fake", "utf16le"));
    await expect(scanInstaller(isolated)).rejects.toThrow(/敏感内容/);
    await expect(assembleInstaller({...f, repoCommit: "pcp_fake", outputDir: path.join(f.memberAgentDir, "dist-installer/bad")})).rejects.toThrow(/敏感内容/);
  });

  it("removes a failed staging directory so rejected content cannot be distributed", async () => {
    const f = await fixture(); const outputDir = path.join(f.memberAgentDir, "dist-installer/rejected");
    await fs.writeFile(path.join(f.memberAgentDir, "src/leaked.ts"), "pcp_fake");
    await expect(assembleInstaller({...f, outputDir})).rejects.toThrow(/敏感内容/);
    await expect(fs.access(path.join(outputDir, "PaperclipMemberAgent-0.2.0"))).rejects.toThrow();
  });

  it.each([
    "OPENAI_BASE_URLsk-proj-sk-svcacct-sk-admin-sk-\0",
    "ask-for-approvalWEB_SEARCHEnable live web search.",
    "sk-proj-sk-svcacct-sk-admin-sk-abcdefgh012345",
    "Petropavlovsk-Kamtsjatski-zomertijd\0",
  ])("rejects public binary text imitated in source or unverified binaries: %s", async (text) => {
    const f = await fixture(); const outputDir = path.join(f.memberAgentDir, "dist-installer/public-prefixes");
    await fs.writeFile(path.join(f.memberAgentDir, "src/imitation.ts"), text);
    await expect(assembleInstaller({...f, outputDir})).rejects.toThrow(/敏感内容/);
    await fs.rm(path.join(f.memberAgentDir, "src/imitation.ts"));
    const scanDir = path.join(f.root, "scan"); await fs.mkdir(path.join(scanDir,"app/codex"),{recursive:true});
    await fs.writeFile(path.join(scanDir,"app/codex/codex.exe"), text);
    await expect(scanInstaller(scanDir)).rejects.toThrow(/固定 SHA-256|敏感内容/);
  });

  it.each(Object.keys(binaryPins))("rejects a changed binary at pinned path %s even with safe text", async (rel) => {
    const f = await fixture(); const scanDir = path.join(f.root,"scan"); await fs.mkdir(path.dirname(path.join(scanDir,rel)),{recursive:true});
    await fs.writeFile(path.join(scanDir,rel),"safe but not pinned bytes");
    await expect(scanInstaller(scanDir)).rejects.toThrow(/固定 SHA-256/);
    await expect(verifyPinnedBinary(path.join(scanDir,rel),rel)).rejects.toThrow(/固定 SHA-256/);
  });

  it.each(["pcp_fake", "sk-abcdefghijklmnopqrstuvwxyz012345", "prefixsk-abcdefghijklmnopqrstuvwxyz012345"])("still scans mismatched canonical Codex bytes for %s", async (text) => {
    const f = await fixture(); const scanDir = path.join(f.root,"scan"); const binary = path.join(scanDir,"app/codex/codex.exe");
    await fs.mkdir(path.dirname(binary),{recursive:true}); await fs.writeFile(binary,text);
    await expect(scanInstaller(scanDir)).rejects.toThrow(/敏感内容/);
  });

  it("does not bypass scanning when official binary bytes are moved to a different path", async () => {
    const f = await fixture(); const scanDir = path.join(f.root,"scan"); await fs.mkdir(scanDir);
    await fs.copyFile(path.join(officialNode,"node.exe"),path.join(scanDir,"renamed.exe"));
    await expect(scanInstaller(scanDir)).rejects.toThrow(/敏感内容/);
  });

  it("rejects a junction escape before creating the requested directory", async () => {
    const f = await fixture(); const outside = path.join(f.root, "outside"); await fs.mkdir(outside);
    await fs.mkdir(path.join(f.memberAgentDir, "dist-installer"));
    await fs.symlink(outside, path.join(f.memberAgentDir, "dist-installer/link"), "junction");
    await expect(assertSafeOutput(path.join(f.memberAgentDir, "dist-installer/link/new"), f.memberAgentDir)).rejects.toThrow(/实际路径|联接/);
    await expect(fs.access(path.join(outside, "new"))).rejects.toThrow();
  });

  it.each(["..", repo, "member-agent/../escape"])("CLI rejects --out %s before any writes or runtime build", (out) => {
    const before = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], {cwd: repo, encoding: "utf8"});
    const result = spawnSync(process.execPath, [script, "--out", out], {cwd: repo, encoding: "utf8", windowsHide: true});
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(1);
    expect(result.stderr).toMatch(/dist-installer/);
    expect(result.stdout).not.toContain("runtime-build");
    const after = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], {cwd: repo, encoding: "utf8"});
    expect(after.stdout).toBe(before.stdout);
  });
});
