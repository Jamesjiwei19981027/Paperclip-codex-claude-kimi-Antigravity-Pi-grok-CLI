import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

export const NODE_VERSION = "24.18.0";
export const NODE_ARCHIVE = `node-v${NODE_VERSION}-win-x64.zip`;
export const CODEX_VERSION = "0.160.0";
// Owner-approved fixed hashes. Updating Node/Codex or these hashes requires
// explicit owner approval; never learn trusted hashes from build inputs.
export const PINNED_BINARIES = Object.freeze({
  "app/node/node.exe": "9a4eb5f1c29c6a2e93852ead46b999e284a6a5ca8bab4d4e241d587d025a52de",
  "app/codex/codex.exe": "fdda5fa3cf3fb3d000b876720742857676293e4315e4b045fae6f8bd7e866d1d",
  "app/codex/codex-code-mode-host.exe": "1d448bfde19e7a280d600d8d0bcddf77afbe9feaec1e804905becc5f39bc9db6",
});
const pinnedScanMethod = "哈希锁定，未做文本扫描";
const memberDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(memberDir, "..");
const runtimeManifestPath = "app/member-agent/runtime/MANIFEST.json";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const inside = (root, target) => { const rel = path.relative(root, target); return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };

async function physicalPath(target) {
  let current = path.resolve(target);
  const missing = [];
  while (true) {
    try { return path.resolve(await fs.realpath(current), ...missing.reverse()); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current)); current = parent;
    }
  }
}

/** Validate before mkdir, runtime building, downloads, or any other mutation. */
export async function assertSafeOutput(output, memberAgentDir = memberDir) {
  const root = path.resolve(memberAgentDir, "dist-installer");
  const absolute = path.resolve(output);
  if (!inside(root, absolute)) throw new Error(`输出目录必须位于 member-agent/dist-installer/ 内：${absolute}`);
  const expectedRoot = path.join(await fs.realpath(memberAgentDir), "dist-installer");
  const actualRoot = await physicalPath(root);
  const actual = await physicalPath(absolute);
  if (path.relative(expectedRoot, actualRoot) !== "" || !inside(expectedRoot, actual)) {
    throw new Error(`输出目录实际路径不得通过符号链接或目录联接逃出 member-agent/dist-installer/：${actual}`);
  }
  return absolute;
}

function parseArgs(args) {
  const options = { outputDir: path.join(memberDir, "dist-installer"), nodeZip: undefined };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]; const value = args[index + 1];
    if (!["--out", "--node-zip"].includes(flag) || seen.has(flag) || !value || value.startsWith("--")) throw new Error("用法：build-installer.mjs [--node-zip <Node ZIP>] [--out <dist-installer 内的目录>]");
    seen.add(flag); options[flag === "--out" ? "outputDir" : "nodeZip"] = path.resolve(value);
  }
  return options;
}

export function officialUrl(resource) {
  const url = new URL(resource, `https://nodejs.org/dist/v${NODE_VERSION}/`);
  if (url.protocol !== "https:" || url.hostname !== "nodejs.org" || url.port || url.username || url.password) throw new Error("Node 下载和所有重定向只允许 https://nodejs.org 官方来源");
  return url;
}

async function download(resource, destination, redirects = 0) {
  const url = officialUrl(resource);
  if (redirects > 5) throw new Error("nodejs.org 重定向过多，已停止；不会尝试镜像。");
  await new Promise((resolve, reject) => {
    const request = https.get(url, { timeout: 60_000 }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume();
        if (!response.headers.location) { reject(new Error("Node 官方下载重定向缺少地址")); return; }
        let next;
        try { next = officialUrl(new URL(response.headers.location, url).href); } catch (error) { reject(error); return; }
        download(next.href, destination, redirects + 1).then(resolve, reject); return;
      }
      if (response.statusCode !== 200) { response.resume(); reject(new Error(`nodejs.org 返回 HTTP ${response.statusCode}；已停止，不会尝试镜像。`)); return; }
      // Use a file handle rather than a shell or a command with interpolated paths.
      fs.open(destination, "w").then(async (handle) => {
        try { for await (const chunk of response) await handle.writeFile(chunk); await handle.close(); resolve(); }
        catch (error) { await handle.close().catch(() => {}); reject(error); }
      }, reject);
    });
    request.on("timeout", () => request.destroy(new Error("nodejs.org 下载超时；已停止，不会尝试镜像。")));
    request.on("error", reject);
  });
}

export async function verifyNodeArchive(zipPath, sumsText) {
  const matching = sumsText.split(/\r?\n/).map((line) => /^([a-fA-F0-9]{64})\s+\*?([^\s]+)\s*$/.exec(line)).filter((match) => match?.[2] === NODE_ARCHIVE);
  if (matching.length !== 1) throw new Error(`官方 SHASUMS256.txt 中必须有且只有一条 ${NODE_ARCHIVE}`);
  const actual = sha256(await fs.readFile(zipPath));
  if (actual !== matching[0][1].toLowerCase()) throw new Error(`Node ZIP SHA-256 校验失败：${NODE_ARCHIVE}`);
  return actual;
}

function powershell(code, env = {}) {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", code], {
    encoding: "utf8", windowsHide: true, env: {...process.env, ...env}, maxBuffer: 16 * 1024 * 1024,
  });
}

async function extractNode(zipPath, destination) {
  await fs.mkdir(destination, {recursive: true});
  powershell("$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip=[IO.Compression.ZipFile]::OpenRead($env:PMA_NODE_ZIP); try { foreach($name in @('node.exe','LICENSE')) { $entryName='node-v' + $env:PMA_NODE_VERSION + '-win-x64/' + $name; $entries=@($zip.Entries | Where-Object { $_.FullName -ceq $entryName }); if($entries.Count -ne 1) { throw ('Node ZIP missing or duplicate file: '+$name) }; [IO.Compression.ZipFileExtensions]::ExtractToFile($entries[0],(Join-Path $env:PMA_NODE_DEST $name),$true) } } finally { $zip.Dispose() }", {
    PMA_NODE_ZIP: path.resolve(zipPath), PMA_NODE_DEST: destination, PMA_NODE_VERSION: NODE_VERSION,
  });
  await verifyPinnedBinary(path.join(destination,"node.exe"),"app/node/node.exe");
  const version = execFileSync(path.join(destination, "node.exe"), ["--version"], {encoding:"utf8", windowsHide:true}).trim();
  if (version !== `v${NODE_VERSION}`) throw new Error(`Node 可执行版本不符：${version}`);
}

async function listFiles(root) {
  const files = [];
  async function visit(dir, relative = "") {
    const entries = await fs.readdir(dir, {withFileTypes: true});
    entries.sort((a,b) => a.name.localeCompare(b.name, "en"));
    for (const entry of entries) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`禁止在安装包中包含符号链接或目录联接：${rel}`);
      if (entry.isDirectory()) await visit(file, rel);
      else if (entry.isFile()) files.push(rel);
      else throw new Error(`禁止的文件类型：${rel}`);
    }
  }
  await visit(root); return files;
}

export async function scanInstaller(root) {
  const jsonWhitelist = new Set(["MANIFEST.json", runtimeManifestPath, "app/member-agent/package.json", "app/member-agent/node_modules/ws/package.json"]);
  const scanReports = [];
  for (const rel of await listFiles(root)) {
    const parts = rel.toLowerCase().split("/"); const name = parts.at(-1);
    if (parts.some((part) => ["test", "tests", "codex-home", "logs", ".git"].includes(part)) || ["auth.json", "config.json"].includes(name) || /\.(log|dpapi|env)$/i.test(name)) throw new Error(`安装包禁止包含本机配置、凭据、测试或日志：${rel}`);
    if (name.endsWith(".json") && !jsonWhitelist.has(rel)) throw new Error(`JSON 文件不在安装包白名单中：${rel}`);
    const bytes = await fs.readFile(path.join(root, rel));
    const pinnedSha256 = PINNED_BINARIES[rel];
    if (pinnedSha256 && sha256(bytes) === pinnedSha256) {
      scanReports.push({path:rel, scanMethod:pinnedScanMethod, pinnedSha256});
      continue;
    }
    for (const text of [bytes.toString("latin1"), bytes.toString("utf16le")]) {
      if (text.includes("pcp_") || /sk-[A-Za-z0-9_-]{20,}/.test(text) || /BEGIN [A-Z ]*PRIVATE KEY/.test(text)) throw new Error(`安装包发现敏感内容，已停止（不显示内容）：${rel}`);
    }
    if (pinnedSha256) throw new Error(`官方二进制固定 SHA-256 校验失败：${rel}`);
    scanReports.push({path:rel, scanMethod:"文本扫描"});
  }
  return scanReports;
}

export async function verifyPinnedBinary(file, relativePath) {
  const pinnedSha256 = PINNED_BINARIES[relativePath];
  if (!pinnedSha256 || sha256(await fs.readFile(file)) !== pinnedSha256) throw new Error(`官方二进制固定 SHA-256 校验失败：${relativePath}`);
  return pinnedSha256;
}

async function copyTree(source, destination) {
  // Resolve only the top-level ws package link. Its files must be real files.
  const real = await fs.realpath(source);
  await listFiles(real);
  await fs.mkdir(path.dirname(destination), {recursive: true});
  await fs.cp(real, destination, {recursive: true, dereference: false, force: true});
}

async function records(root) {
  const result = [];
  for (const rel of await listFiles(root)) {
    if (rel === "MANIFEST.json") continue;
    const bytes = await fs.readFile(path.join(root, rel));
    const record = {path: rel, size: bytes.length, sha256: sha256(bytes)};
    if (PINNED_BINARIES[rel]) {
      if (record.sha256 !== PINNED_BINARIES[rel]) throw new Error(`官方二进制固定 SHA-256 校验失败：${rel}`);
      Object.assign(record,{scanMethod:pinnedScanMethod,pinnedSha256:PINNED_BINARIES[rel]});
    }
    result.push(record);
  }
  return result;
}

/** Stage already verified inputs. CLI always builds runtime and verifies binaries first. */
export async function assembleInstaller({memberAgentDir = memberDir, outputDir, nodeDirectory, codexDirectory, repoCommit}) {
  outputDir = await assertSafeOutput(outputDir, memberAgentDir);
  const metadata = JSON.parse(await fs.readFile(path.join(memberAgentDir, "package.json"), "utf8"));
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(metadata.version)) throw new Error("代理版本格式无效");
  const packageDir = await assertSafeOutput(path.join(outputDir, `PaperclipMemberAgent-${metadata.version}`), memberAgentDir);
  await fs.mkdir(outputDir, {recursive: true});
  await fs.rm(packageDir, {recursive: true, force: true});
  await fs.mkdir(packageDir);
  try {
  const copies = [
    [path.join(memberAgentDir,"src"), "app/member-agent/src"],
    [path.join(memberAgentDir,"package.json"), "app/member-agent/package.json"],
    [path.join(memberAgentDir,"runtime"), "app/member-agent/runtime"],
    [path.join(memberAgentDir,"node_modules/ws"), "app/member-agent/node_modules/ws"],
    [path.join(nodeDirectory,"node.exe"), "app/node/node.exe"],
    [path.join(nodeDirectory,"LICENSE"), "app/node/LICENSE"],
    ...["codex.exe","codex-code-mode-host.exe"].map((name)=>[path.join(codexDirectory,name), `app/codex/${name}`]),
    ...["install.ps1","uninstall.ps1","README-成员安装说明.md"].map((name)=>[path.join(memberAgentDir,"installer",name), name]),
    [path.join(memberAgentDir,"installer/start.ps1"), "app/start.ps1"],
  ];
  for (const [source, rel] of copies) {
    const stat = await fs.stat(source);
    if (stat.isDirectory()) await copyTree(source, path.join(packageDir, rel));
    else { await fs.mkdir(path.dirname(path.join(packageDir,rel)), {recursive: true}); await fs.copyFile(source,path.join(packageDir,rel)); }
  }
  await scanInstaller(packageDir);
  const runtimeManifest = JSON.parse(await fs.readFile(path.join(packageDir,runtimeManifestPath), "utf8"));
  const manifest = {agentVersion: metadata.version, nodeVersion: NODE_VERSION, codexVersion: CODEX_VERSION, runtimeManifest, builtAt:new Date().toISOString(), repoCommit, files: await records(packageDir)};
  await fs.writeFile(path.join(packageDir,"MANIFEST.json"), `${JSON.stringify(manifest,null,2)}\n`, "utf8");
  await scanInstaller(packageDir);
  return {packageDir, manifest};
  } catch (error) {
    await assertSafeOutput(packageDir, memberAgentDir);
    await fs.rm(packageDir, {recursive: true, force: true});
    throw error;
  }
}

export async function compareInstallers(leftDir, rightDir) {
  async function normalized(dir) {
    const outer = JSON.parse(await fs.readFile(path.join(dir,"MANIFEST.json"), "utf8"));
    const actual = await records(dir);
    if (!isDeepStrictEqual(actual, outer.files)) throw new Error(`安装包内容与 MANIFEST 不符（包括 runtime）：${dir}`);
    const inner = JSON.parse(await fs.readFile(path.join(dir,runtimeManifestPath), "utf8"));
    if (!isDeepStrictEqual(inner,outer.runtimeManifest)) throw new Error(`runtime 清单嵌入不一致：${dir}`);
    delete outer.builtAt; delete outer.runtimeManifest.builtAt; delete inner.builtAt;
    // The runtime MANIFEST bytes are verified above, then compared as JSON with
    // only builtAt removed. Its byte size/hash cannot also be compared literally.
    outer.files = outer.files.filter((file)=>file.path !== runtimeManifestPath);
    return {outer, inner};
  }
  if (!isDeepStrictEqual(await normalized(leftDir),await normalized(rightDir))) throw new Error("两次安装包内容不一致（仅排除两个 builtAt）");
}

export async function archiveInstaller(packageDir, zipOutput, memberAgentDir = memberDir) {
  const absoluteOutput = await assertSafeOutput(path.resolve(zipOutput), memberAgentDir);
  await fs.rm(absoluteOutput, {force:true});
  // Explicit entry names avoid .NET Framework's platform-specific backslashes.
  powershell("$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression; Add-Type -AssemblyName System.IO.Compression.FileSystem; $root=[IO.Path]::GetFullPath($env:PMA_PACKAGE_DIR).TrimEnd('\\'); $zip=[IO.Compression.ZipFile]::Open($env:PMA_ZIP_OUTPUT,[IO.Compression.ZipArchiveMode]::Create); try { foreach($file in @(Get-ChildItem -LiteralPath $root -Recurse -File | Sort-Object FullName)) { $relative=$file.FullName.Substring($root.Length+1).Replace('\\','/'); [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip,$file.FullName,$relative,[IO.Compression.CompressionLevel]::Optimal) } } finally { $zip.Dispose() }", {PMA_PACKAGE_DIR:path.resolve(packageDir), PMA_ZIP_OUTPUT:absoluteOutput});
}

export async function buildInstaller(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  const outputDir = await assertSafeOutput(options.outputDir);
  if (process.platform !== "win32") throw new Error("安装包构建仅支持 Windows");
  execFileSync(process.execPath, [path.join(memberDir,"scripts/build-runtime.mjs")], {cwd:repoRoot, stdio:"inherit", windowsHide:true});
  const codexDirectory = path.join(repoRoot,`node_modules/.pnpm/@openai+codex@${CODEX_VERSION}-win32-x64/node_modules/@openai/codex/vendor/x86_64-pc-windows-msvc/bin`);
  for (const name of ["codex.exe","codex-code-mode-host.exe"]) if (!(await fs.stat(path.join(codexDirectory,name))).isFile()) throw new Error(`缺少 Codex 文件：${name}`);
  for (const name of ["codex.exe","codex-code-mode-host.exe"]) await verifyPinnedBinary(path.join(codexDirectory,name),`app/codex/${name}`);
  const version = execFileSync(path.join(codexDirectory,"codex.exe"), ["--version"], {encoding:"utf8", windowsHide:true}).trim();
  if (version !== `codex-cli ${CODEX_VERSION}` && version !== CODEX_VERSION) throw new Error(`Codex 版本必须为 ${CODEX_VERSION}，实际：${version}`);
  await fs.mkdir(outputDir,{recursive:true});
  const work = await fs.mkdtemp(path.join(outputDir,".node-build-"));
  try {
    const sumsPath = path.join(work,"SHASUMS256.txt");
    try { await download("SHASUMS256.txt",sumsPath); }
    catch (error) { throw new Error(`Node 官方 SHASUMS 下载失败，已停止；不会尝试镜像：${error.message}`); }
    const zipPath = options.nodeZip ?? path.join(work,NODE_ARCHIVE);
    if (!options.nodeZip) {
      try { await download(NODE_ARCHIVE,zipPath); }
      catch (error) { throw new Error(`Node 官方 ZIP 下载失败，已停止；不会尝试镜像：${error.message}`); }
    }
    const nodeArchiveSha256 = await verifyNodeArchive(zipPath,await fs.readFile(sumsPath,"utf8"));
    console.log(`[installer-build] Node 官方 ZIP SHA-256：${nodeArchiveSha256}`);
    const nodeDirectory = path.join(work,"node"); await extractNode(zipPath,nodeDirectory);
    const repoCommit = execFileSync("git",["rev-parse","HEAD"],{cwd:repoRoot,encoding:"utf8",windowsHide:true}).trim();
    const result = await assembleInstaller({outputDir,nodeDirectory,codexDirectory,repoCommit});
    const zipOutput = await assertSafeOutput(path.join(outputDir,`PaperclipMemberAgent-${result.manifest.agentVersion}.zip`));
    await archiveInstaller(result.packageDir, zipOutput);
    console.log(`[installer-build] 构建完成：${zipOutput}`);
    console.log(`[installer-build] ZIP SHA-256：${sha256(await fs.readFile(zipOutput))}`);
    return {...result,zipOutput};
  } finally { await fs.rm(work,{recursive:true,force:true}); }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { await buildInstaller(); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
