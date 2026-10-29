import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, lstat, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { buildLoginEnvironment } from "./codex-cli.ts";
import { assertIsolatedConfigHome } from "./executors/shared-support.ts";

export const CODEBUDDY_VERSION = "2.169.0";
const execFileAsync = promisify(execFile);
export async function hasCodeBuddyLogin(profile = homedir(), exists: typeof access = access): Promise<boolean> {
  // Never read, copy, hash or log credential contents.
  try { await exists(path.join(profile, "AppData/Local/CodeBuddyExtension/Data/Public/auth/Tencent-Cloud.coding-copilot.info")); return true; }
  catch { return false; }
}
export function buildCodeBuddyLoginEnvironment(source: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const env = buildLoginEnvironment(source, home);
  delete env.CODEX_HOME;
  env.CODEBUDDY_CONFIG_DIR = home;
  return env;
}
export async function readCodeBuddyVersion(entry: string, home: string): Promise<string> {
  await assertIsolatedConfigHome(home, path.join(homedir(), ".codebuddy"));
  const result = await execFileAsync(process.execPath, [entry, "--version"], { encoding: "utf8", windowsHide: true, timeout: 20_000, env: buildCodeBuddyLoginEnvironment(process.env, home) });
  const version = result.stdout.match(/\b\d+\.\d+\.\d+\b/)?.[0];
  if (!version) throw new Error("无法读取 CodeBuddy 版本。");
  return version;
}
export async function runCodeBuddyLogin(entry: string, home: string): Promise<number> {
  await assertIsolatedConfigHome(home, path.join(homedir(), ".codebuddy"));
  const child = spawn(process.execPath, [entry], { env: buildCodeBuddyLoginEnvironment(process.env, home), stdio: "inherit", windowsHide: false });
  return new Promise<number>((resolve, reject) => {
    child.once("error", () => reject(new Error("无法启动 CodeBuddy 登录，请检查 codebuddyEntry。")));
    child.once("close", code => resolve(code ?? 1));
  });
}

const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
async function plainFiles(root: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error("清单目录不得包含链接。");
    if (entry.isDirectory()) files.push(...await plainFiles(root, rel));
    else if (entry.isFile()) files.push(rel);
  }
  return files;
}

/** Supports the extracted ZIP and the installed versionRoot/PACKAGE-MANIFEST.json. */
export async function verifyCodeBuddyPackage(entry: string): Promise<string[]> {
  let root = path.dirname(entry);
  while (path.dirname(root) !== root) {
    const installed = path.join(root, "PACKAGE-MANIFEST.json");
    const extracted = path.join(root, "MANIFEST.json");
    const manifestFile = await access(installed).then(() => installed, () => null)
      ?? await access(extracted).then(() => extracted, () => null);
    if (manifestFile) {
      try {
        const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
        if (!Array.isArray(manifest.files)) { root = path.dirname(root); continue; }
        const app = manifestFile === installed ? root : path.join(root, "app");
        const records = manifest.files.filter((file: { path?: string }) => file.path?.startsWith("app/"));
        const listed = new Set<string>();
        const critical = new Set([
          "codebuddy/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy",
          "codebuddy/package.json", "codebuddy/package-lock.json",
          "codebuddy/node_modules/@tencent-ai/codebuddy-code/package.json",
        ]);
        const issues: string[] = [];
        for (const record of records) {
          const rel = String(record.path).slice(4);
          if (!rel || /\\|:|(^|\/)\.\.?($|\/)|^\//.test(rel) || listed.has(rel) || !/^[a-f0-9]{64}$/i.test(record.sha256)) throw new Error("非法清单");
          listed.add(rel);
          const file = path.join(app, rel);
          const info = await lstat(file);
          const hashRequired = manifestFile !== installed || critical.has(rel);
          if (!info.isFile() || info.isSymbolicLink() || info.size !== record.size || (hashRequired && sha(await readFile(file)) !== record.sha256)) issues.push(`文件大小或哈希不符：${record.path}`);
        }
        if (!listed.has("codebuddy/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy")) issues.push("清单缺少 CodeBuddy 入口");
        if (!path.resolve(entry).toLowerCase().startsWith(path.resolve(app, "codebuddy").toLowerCase() + path.sep)) issues.push("CodeBuddy 入口与清单不匹配");
        for (const file of await plainFiles(path.join(app, "codebuddy"))) if (!listed.has(`codebuddy/${file}`)) issues.push(`CodeBuddy 文件未列入清单：${file}`);
        return issues;
      } catch { return ["安装包清单损坏或文件缺失，请重新获取安装包。"]; }
    }
    root = path.dirname(root);
  }
  return ["缺少安装包 MANIFEST，请使用完整的 CodeBuddy 安装包。"];
}

export async function verifyCodeBuddyRuntime(runtimeDir: string): Promise<string[]> {
  try {
    const manifest = JSON.parse(await readFile(path.join(runtimeDir, "MANIFEST.json"), "utf8"));
    const files = { "server/dist/codex-local.mjs": manifest.bundleSha256, ...manifest.assets } as Record<string, string>;
    if (!files["server/dist/claude-local.mjs"]) return ["MANIFEST 缺少 Claude CLI bundle"];
    const issues: string[] = [];
    for (const [rel, hash] of Object.entries(files)) {
      if (/\\|:|(^|\/)\.\.?($|\/)|^\//.test(rel) || sha(await readFile(path.join(runtimeDir, rel))) !== hash) issues.push("运行时文件哈希不符");
    }
    await access(path.join(runtimeDir, "skills/paperclip/SKILL.md"));
    return issues;
  } catch { return ["运行时缺失或 MANIFEST 无效，请重新运行 build-runtime。"]; }
}
export async function inspectCodeBuddyInstallation(input: { codebuddyEntry: string; codebuddyHome: string; runtimeDir: string }) {
  const packageIssues = await verifyCodeBuddyPackage(input.codebuddyEntry);
  const [version, loggedIn, runtimeIssues] = await Promise.all([
    packageIssues.length ? Promise.resolve(null) : readCodeBuddyVersion(input.codebuddyEntry, input.codebuddyHome).catch(() => null),
    hasCodeBuddyLogin(), verifyCodeBuddyRuntime(input.runtimeDir),
  ]);
  return { version, loggedIn, packageIssues, runtimeIssues, ok: version === CODEBUDDY_VERSION && loggedIn && !packageIssues.length && !runtimeIssues.length };
}
