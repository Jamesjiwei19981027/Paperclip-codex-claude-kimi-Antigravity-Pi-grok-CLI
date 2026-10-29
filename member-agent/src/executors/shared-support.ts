import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, symlink, cp, stat as fsStat, realpath as fsRealpath } from "node:fs/promises";
import path from "node:path";

export interface CodexPathsConfig {
  projectDirs: Record<string, unknown>;
  defaultCwd: string;
  configDir: string;
  codexHome: string;
  runtimeDir: string;
  additionalForbiddenDirs?: string[];
}

function pathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** Resolve existing ancestors too, so a not-yet-created home cannot escape through a junction. */
export async function assertIsolatedConfigHome(home: string, personalHome: string): Promise<string> {
  if (!path.isAbsolute(home)) throw new Error("codebuddyHome 必须是成员代理专属的绝对路径。");
  const physical = async (input: string): Promise<string> => {
    let current = path.resolve(input);
    const tail: string[] = [];
    while (true) {
      try { return path.resolve(await fsRealpath(current), ...tail.reverse()); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const parent = path.dirname(current);
        if (parent === current) throw error;
        tail.push(path.basename(current)); current = parent;
      }
    }
  };
  const [actual, personal] = await Promise.all([physical(home), physical(personalHome)]);
  if (pathInside(personalHome, home) || pathInside(personal, actual)) throw Object.assign(new Error("codebuddyHome 不得指向个人 .codebuddy 目录或其内部目录（包括目录联接）。"), { code: "member_agent_configuration_error" });
  return actual;
}

function hasParentSegment(input: string): boolean {
  return input.split(/[\\/]+/).includes("..");
}

function looksUnc(input: string): boolean {
  return /^(?:\\\\|\/\/)/.test(input);
}

export async function resolveLocalCwd(
  context: Record<string, unknown>,
  config: CodexPathsConfig,
  fileSystem: { stat: typeof fsStat; realpath?: typeof fsRealpath } = { stat: fsStat, realpath: fsRealpath },
): Promise<{ projectId: string; cwd: string }> {
  const workspace = isRecord(context.paperclipWorkspace) ? context.paperclipWorkspace : {};
  const projectId = typeof workspace.projectId === "string" && workspace.projectId.trim()
    ? workspace.projectId
    : typeof context.projectId === "string" && context.projectId.trim() ? context.projectId : "";
  const mapped = projectId ? config.projectDirs[projectId] : undefined;
  const rawPath = typeof mapped === "string" && mapped.trim() ? mapped : config.defaultCwd;
  const directory = rawPath?.trim() ? rawPath : "（未配置）";
  const subject = projectId ? `项目 ${projectId} 的本机目录 ${directory}` : `默认工作目录 ${directory}（安装时填写）`;
  if (!rawPath || !rawPath.trim()) {
    throw Object.assign(new Error(`${subject} 没有配置，请在 projectDirs 中添加映射或填写 defaultCwd。`), { code: "member_agent_cwd_unresolved" });
  }
  if (hasParentSegment(rawPath)) {
    throw Object.assign(new Error(`${subject} 含有 .. 路径段，请改为规范的绝对路径。`), { code: "member_agent_cwd_unresolved" });
  }
  if (looksUnc(rawPath)) {
    throw Object.assign(new Error(`${subject} 不能使用 UNC 路径，请配置本机磁盘上的绝对目录。`), { code: "member_agent_cwd_unresolved" });
  }
  if (!path.isAbsolute(rawPath)) {
    throw Object.assign(new Error(`${subject} 必须是绝对路径，请修改 projectDirs 或 defaultCwd。`), { code: "member_agent_cwd_unresolved" });
  }
  const cwd = path.resolve(rawPath);
  const userProfile = process.env.USERPROFILE;
  const defaultCodexHome = userProfile ? path.join(userProfile, ".codex") : "";
  const forbidden = [config.configDir, config.codexHome, config.runtimeDir, defaultCodexHome, ...(config.additionalForbiddenDirs ?? [])].filter(Boolean);
  if (forbidden.some((directory) => pathInside(directory, cwd))) {
    throw Object.assign(new Error(`${subject} 位于代理配置、Codex Home 或运行时目录内，请选择独立项目目录。`), { code: "member_agent_cwd_unresolved" });
  }
  function inspectionError(error: unknown): Error {
    const code = (error as NodeJS.ErrnoException)?.code;
    const reason = code === "EACCES" || code === "EPERM" ? "无权限访问，请检查目录访问权限"
      : code === "ENOENT" || code === "ENOTDIR" ? "不存在，请先创建目录并更新 projectDirs 或 defaultCwd"
      : "无法访问，请检查目录状态和访问权限";
    return Object.assign(new Error(`${subject} ${reason}。`), { code: "member_agent_cwd_missing" });
  }
  let stats;
  try { stats = await fileSystem.stat(cwd); }
  catch (error) { throw inspectionError(error); }
  if (!stats.isDirectory()) {
    throw Object.assign(new Error(`${subject} 不是目录，请更新 projectDirs 或 defaultCwd。`), { code: "member_agent_cwd_missing" });
  }
  let actualCwd: string;
  try { actualCwd = await (fileSystem.realpath ?? fsRealpath)(cwd); }
  catch (error) { throw inspectionError(error); }
  for (const directory of forbidden) {
    let actualProtected = path.resolve(directory);
    try { actualProtected = await (fileSystem.realpath ?? fsRealpath)(directory); } catch { /* A not-yet-created CODEX_HOME is still guarded lexically. */ }
    if (pathInside(actualProtected, actualCwd)) {
      throw Object.assign(new Error(`${subject}（实际路径 ${actualCwd}）位于代理配置、Codex Home 或运行时目录内，请选择独立项目目录。`), { code: "member_agent_cwd_unresolved" });
    }
  }
  return { projectId, cwd: actualCwd };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function localizeContext(
  original: Record<string, unknown>,
  cwd: string,
  agentHome: string,
): { context: Record<string, unknown>; suspectedServerPaths: number } {
  const context: Record<string, unknown> = { ...original };
  delete context.paperclipWorkspaces;
  // Handoff is passed through the dedicated getFreshSessionHandoff callback.
  // Do not retain legacy summary copies that may contain server-side paths.
  delete context.paperclipSessionHandoffMarkdown;
  delete context.paperclipContinuationSummary;
  const workspace = isRecord(original.paperclipWorkspace) ? { ...original.paperclipWorkspace } : {};
  workspace.cwd = cwd;
  delete workspace.worktreePath;
  workspace.agentHome = agentHome;
  context.paperclipWorkspace = workspace;

  const serverPathPattern = /(?:\b[A-Za-z]:[\\/]|(?:^|[\s"'])\/(?:workspace|workspaces|home|Users|tmp)\/)/g;
  let suspectedServerPaths = 0;
  for (const [key, value] of Object.entries(context)) {
    if (/markdown|summary|description|prompt|guidance/i.test(key) && typeof value === "string") {
      suspectedServerPaths += [...value.matchAll(serverPathPattern)].length;
    }
  }
  return { context, suspectedServerPaths };
}

export function rebaseEndpoint(endpoint: string, serverUrl: string): string {
  try {
    const source = new URL(endpoint);
    const base = new URL(serverUrl);
    source.protocol = base.protocol;
    source.host = base.host;
    source.port = base.port;
    return source.toString();
  } catch {
    return endpoint;
  }
}

async function hashDirectory(root: string): Promise<string> {
  const hash = createHash("sha256");
  const walk = async (directory: string, prefix: string) => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        hash.update(`L\0${relative}\0`);
        hash.update(await readFile(full));
      } else if (entry.isDirectory()) {
        hash.update(`D\0${relative}\0`);
        await walk(full, relative);
      } else if (entry.isFile()) {
        const mode = (await lstat(full)).mode & 0o777;
        hash.update(`F\0${relative}\0${mode}\0`);
        hash.update(await readFile(full));
      }
    }
  };
  await walk(root, "");
  return hash.digest("hex");
}

export interface SkillFs {
  lstat: typeof lstat;
  mkdir: typeof mkdir;
  readdir: typeof readdir;
  readFile: typeof readFile;
  rename: typeof rename;
  rm: typeof rm;
  cp: typeof cp;
  symlink: typeof symlink;
}

const nativeFs: SkillFs = { lstat, mkdir, readdir, readFile, rename, rm, cp, symlink };

export async function materializeSkills(
  runtimeDir: string,
  codexHome: string,
  fileSystem: SkillFs = nativeFs,
): Promise<void> {
  const sourceRoot = path.join(runtimeDir, "skills");
  const skillsDir = path.join(codexHome, "skills");
  await fileSystem.mkdir(skillsDir, { recursive: true });
  const entries = (await fileSystem.readdir(sourceRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name === ".system") continue;
    const source = path.join(sourceRoot, entry.name);
    const target = path.join(skillsDir, entry.name);
    let current;
    try { current = await fileSystem.lstat(target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!current) {
      await fileSystem.cp(source, target, { recursive: true, errorOnExist: true, force: false });
      continue;
    }
    if (current.isSymbolicLink()) {
      await fileSystem.rm(target, { recursive: true, force: true });
      await fileSystem.cp(source, target, { recursive: true, errorOnExist: true, force: false });
      continue;
    }
    if (!current.isDirectory()) {
      throw new Error(`技能目标 ${entry.name} 已存在但不是目录。`);
    }
    if (await hashDirectory(source) === await hashDirectory(target)) continue;

    const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const staged = path.join(skillsDir, `.${entry.name}.${token}.new`);
    const backup = path.join(skillsDir, `.${entry.name}.${token}.old`);
    await fileSystem.cp(source, staged, { recursive: true, errorOnExist: true, force: false });
    try {
      await fileSystem.rename(target, backup);
      try { await fileSystem.rename(staged, target); }
      catch (error) { await fileSystem.rename(backup, target).catch(() => undefined); throw error; }
      await fileSystem.rm(backup, { recursive: true, force: true });
    } finally {
      await fileSystem.rm(staged, { recursive: true, force: true });
    }
  }
}
