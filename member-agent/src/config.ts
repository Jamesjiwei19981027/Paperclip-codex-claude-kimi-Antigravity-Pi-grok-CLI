import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Redactor } from "./logger.ts";

export interface Config {
  serverUrl: string;
  agentKey: string;
  executor: "echo" | "codex" | "codebuddy";
  projectDirs: Record<string, unknown>;
  defaultCwd: string;
  /** Test-only echo delay; real executors must not consume this option. */
  echoHoldSec: number;
  codebuddyEntry?: string;
  codebuddyHome?: string;
  codebuddyModel?: string;
  codexExecutable?: string;
  codexHome?: string;
  runtimeDir?: string;
}

export class ConfigError extends Error {
  readonly messages: string[];
  readonly code = 2;
  constructor(messages: string[]) { super(messages.join("\n")); this.name = "ConfigError"; this.messages = messages; }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateConfig(value: unknown, env: NodeJS.ProcessEnv = process.env, options: { requireAgentKey?: boolean } = {}): Config {
  if (!isObject(value)) throw new ConfigError(["配置错误：配置必须是 JSON 对象，请按示例填写配置文件。"]);
  const errors: string[] = [];
  const redactor = new Redactor(); redactor.register(value.agentKey, env.PAPERCLIP_AGENT_KEY);
  const allowed = new Set(["serverUrl", "agentKey", "executor", "projectDirs", "defaultCwd", "echoHoldSec", "codexExecutable", "codexHome", "runtimeDir", "codebuddyEntry", "codebuddyHome", "codebuddyModel"]);
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) errors.push(`配置错误：未知字段 ${redactor.redact(JSON.stringify(field))}，请删除或改为正确字段名。`);
  }
  let serverUrl = "";
  try {
    // Check the original spelling, before URL normalization can remove /x/.. .
    if (typeof value.serverUrl !== "string" || !/^https?:\/\/[^/?#\\\s]+\/?$/.test(value.serverUrl)) throw new Error();
    const parsed = new URL(value.serverUrl);
    if (!parsed.hostname || parsed.username || parsed.password || parsed.pathname !== "/" || value.serverUrl.includes("?") || value.serverUrl.includes("#")) throw new Error();
    serverUrl = parsed.origin;
  } catch {
    errors.push("配置错误：serverUrl 必须是 http:// 或 https:// 源地址，不得含路径、查询、片段或账号密码，请填写例如 http://192.168.0.213:3100。");
  }
  const agentKey = env.PAPERCLIP_AGENT_KEY ?? value.agentKey;
  if (options.requireAgentKey !== false && (typeof agentKey !== "string" || !agentKey.trim() || /[\r\n]/.test(agentKey))) errors.push("配置错误：agentKey 必须是非空字符串且不得含换行，请填写 Key 或设置 PAPERCLIP_AGENT_KEY 环境变量。");
  if (value.executor !== "echo" && value.executor !== "codex" && value.executor !== "codebuddy") errors.push('配置错误：executor 必须是 "echo"、"codex" 或 "codebuddy"，请修改执行器设置。');
  if (!isObject(value.projectDirs)) errors.push("配置错误：projectDirs 必须是对象，本阶段请填写 {}。");
  if (typeof value.defaultCwd !== "string") errors.push('配置错误：defaultCwd 必须是字符串，本阶段可填写 ""。');
  const echoHoldSec = value.echoHoldSec === undefined ? 0 : value.echoHoldSec;
  if (typeof echoHoldSec !== "number" || !Number.isInteger(echoHoldSec) || echoHoldSec < 0 || echoHoldSec > 600) errors.push("配置错误：echoHoldSec 必须是整数，范围为 0 到 600；此项仅用于 echo 验收测试。");
  const validateAbsolutePath = (field: "codexExecutable" | "codexHome" | "runtimeDir" | "codebuddyEntry" | "codebuddyHome", options: { required?: boolean; executable?: boolean } = {}): string | undefined => {
    const candidate = value[field];
    if (candidate === undefined && options.required !== true) return undefined;
    if (typeof candidate !== "string" || !candidate.trim() || !path.isAbsolute(candidate)) {
      errors.push(`配置错误：${field} 必须是绝对路径${options.required === true ? "且为必填项" : ""}，请填写完整本机路径。`);
      return undefined;
    }
    if (options.executable && path.extname(candidate).toLowerCase() !== ".exe") {
      errors.push(`配置错误：${field} 必须指向 .exe 文件，不支持 .cmd 或 .bat，请填写 Codex 可执行文件的绝对路径。`);
      return undefined;
    }
    return path.resolve(candidate);
  };
  let codexExecutable: string | undefined;
  let codexHome: string | undefined;
  let runtimeDir: string | undefined;
  const hasBaseFieldErrors = errors.some((message) => /serverUrl|agentKey|executor 必须|projectDirs|defaultCwd|echoHoldSec/.test(message));
  if (value.executor === "codex") {
    if (hasBaseFieldErrors) {
      // Avoid cascading path diagnostics while the base configuration is
      // malformed; retain one executor-level hint, then report all Codex path
      // fields together once the common fields are valid.
      errors.push("配置错误：executor 的 Codex 配置需要先修复上述基础字段，然后才能校验 Codex 路径。");
    } else {
      codexExecutable = validateAbsolutePath("codexExecutable", { required: true, executable: true });
      codexHome = validateAbsolutePath("codexHome", { required: true });
      runtimeDir = validateAbsolutePath("runtimeDir", { required: true });
    }
    if (codexHome) {
      const profile = env.USERPROFILE;
      if (profile && path.resolve(codexHome).toLowerCase() === path.resolve(profile, ".codex").toLowerCase()) {
        errors.push("配置错误：codexHome 不得使用 %USERPROFILE%\\.codex，请为成员代理设置独立目录。");
      }
    }
  } else {
    codexExecutable = validateAbsolutePath("codexExecutable", { executable: true });
    codexHome = validateAbsolutePath("codexHome");
    runtimeDir = validateAbsolutePath("runtimeDir");
  }
  const codebuddyEntry = validateAbsolutePath("codebuddyEntry", { required: value.executor === "codebuddy" });
  const codebuddyHome = validateAbsolutePath("codebuddyHome", { required: value.executor === "codebuddy" });
  if (value.executor === "codebuddy") runtimeDir = validateAbsolutePath("runtimeDir", { required: true });
  if (codebuddyHome && (env.USERPROFILE ?? env.HOME)) {
    const rel = path.relative(path.resolve((env.USERPROFILE ?? env.HOME)!, ".codebuddy"), codebuddyHome);
    if (rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel))) errors.push("配置错误：codebuddyHome 不得使用个人 .codebuddy 目录或其内部目录，请设置成员代理独立目录。");
  }
  if (codebuddyEntry && (path.basename(codebuddyEntry) !== "codebuddy" || path.basename(path.dirname(codebuddyEntry)) !== "bin")) errors.push("配置错误：codebuddyEntry 必须指向 bin/codebuddy 入口文件。");
  const codebuddyModel = typeof value.codebuddyModel === "string" ? value.codebuddyModel.trim() : undefined;
  if (value.codebuddyModel !== undefined && (codebuddyModel === undefined || /[\r\n\0]/.test(codebuddyModel) || /^claude-/i.test(codebuddyModel))) errors.push("配置错误：codebuddyModel 必须是 CodeBuddy 模型名字符串，不能使用 claude-*；留空使用账号默认模型。");
  if (errors.length) throw new ConfigError(errors.map((message) => redactor.redact(message)));
  return { serverUrl, agentKey: agentKey as string, executor: value.executor as "echo" | "codex" | "codebuddy", projectDirs: value.projectDirs as Record<string, unknown>, defaultCwd: value.defaultCwd as string, echoHoldSec: echoHoldSec as number, codebuddyEntry, codebuddyHome, codebuddyModel, codexExecutable, codexHome, runtimeDir };
}

const execFileAsync = promisify(execFile);

async function warnPermissions(configPath: string, warn: (message: string) => void): Promise<void> {
  if (process.platform !== "win32") return;
  const username = userInfo().username;
  let currentAccount = username;
  let warnNeeded = false;
  try {
    // PowerShell decodes icacls using the Windows console code page, then
    // returns UTF-8 bytes as ASCII base64 without changing that code page.
    const systemRoot = process.env.SystemRoot;
    if (!systemRoot || !path.isAbsolute(systemRoot)) throw new Error("Windows system directory unavailable");
    const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const script = `$ErrorActionPreference='Stop';$icacls=Join-Path $env:SystemRoot 'System32\\icacls.exe';$lines=@(& $icacls $env:PAPERCLIP_ACL_TARGET 2>$null);if($LASTEXITCODE -ne 0){exit $LASTEXITCODE};$payload=@{account=[Security.Principal.WindowsIdentity]::GetCurrent().Name;acl=[string]::Join([char]10,[string[]]$lines)}|ConvertTo-Json -Compress;[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload))`;
    const env: NodeJS.ProcessEnv = { PAPERCLIP_ACL_TARGET: configPath };
    for (const key of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "TEMP", "TMP"]) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    const { stdout } = await execFileAsync(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, encoding: "utf8", timeout: 15_000, env });
    const decoded = JSON.parse(Buffer.from(stdout.trim(), "base64").toString("utf8")) as { account?: unknown; acl?: unknown };
    if (typeof decoded.account !== "string" || !decoded.account || typeof decoded.acl !== "string") throw new Error("Windows ACL identity unavailable");
    currentAccount = decoded.account;
    const acl = decoded.acl.split(/\r?\n/).map((line) => line.trim()).filter((line) => /:\(/.test(line));
    warnNeeded = acl.length === 0 || acl.some((line) => {
      const principal = line.slice(0, line.indexOf(":(")).replace(configPath, "").trim().toLowerCase();
      const isCurrent = principal === username.toLowerCase() || principal === currentAccount.toLowerCase();
      const grant = line.slice(line.indexOf(":(") + 1);
      return !isCurrent && !grant.includes("(DENY)") && /(?:\(|,)(?:F|M|RX|R|RD|RC|GR|GA)(?:,|\))/.test(grant);
    });
  } catch { warnNeeded = true; }
  if (warnNeeded) {
    // Paths/accounts are quoted for PowerShell; no config contents enter this warning.
    const quote = (text: string) => `'${text.replace(/'/g, "''")}'`;
    warn(`警告：配置文件可能允许其他账户读取，或无法确认权限。请在 PowerShell 收紧权限：icacls ${quote(configPath)} /reset; icacls ${quote(configPath)} /inheritance:r /grant:r ${quote(`${currentAccount}:(R)`)}`);
  }
}

export async function loadConfig(configPath?: string, env: NodeJS.ProcessEnv = process.env, warningSink: (message: string) => void = console.warn, options: { requireAgentKey?: boolean } = {}): Promise<Config> {
  if (!configPath && !env.APPDATA) throw new ConfigError(["配置错误：APPDATA 未设置，请使用 --config 指定配置文件。"]);
  const resolved = path.resolve(configPath ?? path.join(env.APPDATA!, "paperclip-member-agent", "config.json"));
  let text: string;
  try { text = await readFile(resolved, "utf8"); }
  catch { throw new ConfigError(["配置错误：无法读取 config.json，请确认 --config 文件存在且当前账户有读取权限。"]); }
  if (text.charCodeAt(0) === 0xfeff) throw new ConfigError(["配置错误：config.json 含 UTF-8 BOM，请另存为无 BOM 的 UTF-8 JSON 文件。"]);
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new ConfigError(["配置错误：config.json 不是合法 JSON，请检查逗号、引号和括号。"]); }
  const config = validateConfig(value, env, options);
  const redactor = new Redactor(); redactor.register(config.agentKey, isObject(value) ? value.agentKey : undefined);
  await warnPermissions(resolved, (message) => warningSink(redactor.redact(message)));
  return config;
}
