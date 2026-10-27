import { execFile, spawn } from "node:child_process";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const CODE_MODE_HOST_FILENAME = "codex-code-mode-host.exe";
export const CODE_MODE_HOST_RECOVERY = "codexExecutable 同目录缺少或无法读取 codex-code-mode-host.exe。请从同一版本 Codex 安装包的同一目录，将 codex.exe 和 codex-code-mode-host.exe 一起复制到成员电脑并放在同一目录。";
const BUNDLE_FILES = [
  "server/dist/codex-local.mjs",
  "server/dist/codex-auth-merge-decision.cjs",
  "server/dist/codex-auth-merge-extract.sh",
  "skills/paperclip",
  "MANIFEST.json",
] as const;

export function parseCodexVersion(output: string): string | null {
  const match = /\bcodex-cli\s+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/i.exec(output);
  return match?.[1] ?? null;
}

export async function readCodexVersion(executable: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(executable, ["--version"], { windowsHide: true, timeout: 10_000, maxBuffer: 16 * 1024, encoding: "utf8" });
    const version = parseCodexVersion(stdout);
    if (!version) throw new Error();
    return version;
  } catch {
    throw new Error("无法读取 Codex 版本；请确认 codexExecutable 指向可运行的固定版本 codex.exe。");
  }
}

export async function isCodexExecutableReady(executable: string): Promise<boolean> {
  try {
    const info = await stat(executable);
    if (!info.isFile() || path.extname(executable).toLowerCase() !== ".exe") return false;
    await access(executable);
    return true;
  } catch { return false; }
}

export async function isCodexCodeModeHostReady(executable: string): Promise<boolean> {
  const host = path.join(path.dirname(executable), CODE_MODE_HOST_FILENAME);
  try {
    if (!(await stat(host)).isFile()) return false;
    await access(host);
    return true;
  } catch { return false; }
}

/** Check only existence and file type. Never read or return auth.json contents. */
export async function hasCodexLogin(codexHome: string): Promise<boolean> {
  try { return (await stat(path.join(codexHome, "auth.json"))).isFile(); }
  catch { return false; }
}

export async function missingRuntimeFiles(runtimeDir: string): Promise<string[]> {
  const missing: string[] = [];
  for (const relative of BUNDLE_FILES) {
    try {
      const target = path.join(runtimeDir, ...relative.split("/"));
      const info = await stat(target);
      if (relative === "skills/paperclip" ? !info.isDirectory() : !info.isFile()) missing.push(relative);
    } catch { missing.push(relative); }
  }
  return missing;
}

export interface CodexCheckResult {
  executable: boolean;
  codeModeHost: boolean;
  version: string | null;
  loggedIn: boolean;
  missingRuntime: string[];
}

export async function inspectCodexInstallation(input: { executable: string; codexHome: string; runtimeDir: string }, dependencies: {
  executableReady?: (executable: string) => Promise<boolean>;
  codeModeHostReady?: (executable: string) => Promise<boolean>;
  getVersion?: (executable: string) => Promise<string>;
  hasLogin?: (codexHome: string) => Promise<boolean>;
  missingRuntime?: (runtimeDir: string) => Promise<string[]>;
} = {}): Promise<CodexCheckResult> {
  const executableReady = dependencies.executableReady ?? isCodexExecutableReady;
  const codeModeHostReady = dependencies.codeModeHostReady ?? isCodexCodeModeHostReady;
  const getVersion = dependencies.getVersion ?? readCodexVersion;
  const loginCheck = dependencies.hasLogin ?? hasCodexLogin;
  const runtimeCheck = dependencies.missingRuntime ?? missingRuntimeFiles;
  const [executable, codeModeHost, versionResult, loggedIn, missingRuntime] = await Promise.all([
    executableReady(input.executable).catch(() => false),
    codeModeHostReady(input.executable).catch(() => false),
    getVersion(input.executable).then((value) => ({ value })).catch(() => ({ value: null })),
    loginCheck(input.codexHome).catch(() => false),
    runtimeCheck(input.runtimeDir).catch(() => ["无法检查运行时目录"]),
  ]);
  return { executable, codeModeHost, version: versionResult.value, loggedIn, missingRuntime };
}

const LOGIN_ENV_KEYS = [
  "PATH", "PATHEXT", "SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
  "APPDATA", "LOCALAPPDATA", "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "ComSpec", "HOME", "LANG", "TERM",
] as const;

export function buildLoginEnvironment(source: NodeJS.ProcessEnv, codexHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of LOGIN_ENV_KEYS) if (source[key] !== undefined) env[key] = source[key];
  env.CODEX_HOME = codexHome;
  return env;
}

/** Runs the Codex device login directly in the caller's terminal; output is never captured or logged. */
export async function runCodexLogin(executable: string, codexHome: string, sourceEnv: NodeJS.ProcessEnv = process.env, spawnImpl: typeof spawn = spawn): Promise<number> {
  const child = spawnImpl(executable, ["login", "--device-auth"], {
    env: buildLoginEnvironment(sourceEnv, codexHome),
    stdio: "inherit",
    windowsHide: false,
  });
  return await new Promise<number>((resolve, reject) => {
    child.once("error", () => reject(new Error("无法启动 Codex 登录；请确认 codexExecutable 可运行。")));
    child.once("close", (code) => resolve(code ?? 1));
  });
}
