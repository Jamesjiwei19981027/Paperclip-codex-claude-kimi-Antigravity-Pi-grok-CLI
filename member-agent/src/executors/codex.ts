import { access, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Executor, ExecutorHooks, ExecutorResult, JobStart } from "./types.ts";
import { isRecord, localizeContext, materializeSkills, rebaseEndpoint, resolveLocalCwd } from "./codex-support.ts";
import { CODE_MODE_HOST_RECOVERY, isCodexCodeModeHostReady } from "../codex-cli.ts";

export interface CodexRuntimeConfig {
  codexExecutable: string;
  codexHome: string;
  runtimeDir: string;
  projectDirs: Record<string, unknown>;
  defaultCwd: string;
  configDir: string;
}

export interface CodexModule {
  execute(context: Record<string, unknown>): Promise<unknown>;
}

export interface CodexExecutorDependencies {
  loadRuntime?: (entry: string) => Promise<CodexModule>;
  access?: typeof access;
  mkdir?: typeof mkdir;
  stat?: typeof stat;
  materializeSkills?: typeof materializeSkills;
  processEnv?: NodeJS.ProcessEnv;
  warn?: (message: string) => void;
}

const REQUIRED_ASSETS = [
  "server/dist/codex-auth-merge-decision.cjs",
  "server/dist/codex-auth-merge-extract.sh",
] as const;
const RESULT_FIELDS = new Set([
  "exitCode", "signal", "timedOut", "errorCode", "errorMessage", "errorFamily", "retryNotBefore", "errorMeta",
  "summary", "resultJson", "sessionId", "sessionDisplayId", "sessionParams", "clearSession", "usageComplete",
  "executionRecovery", "usage", "usageByModel", "usageBasis", "provider", "biller", "model", "billingType",
  "costUsd", "costUsdExact", "costStatus", "pricingContext", "pricingProvenance", "cacheAdjustedCostUsd", "providerRequestId",
]);
const PROCESS_ENV_ALLOWLIST = new Set([
  "PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP",
  "APPDATA", "LOCALAPPDATA", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "HOME", "LANG", "LC_ALL", "TZ",
  "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER", "NUMBER_OF_PROCESSORS", "OS",
]);

let cachedRuntime: CodexModule | null = null;
let cachedRuntimePath = "";

function resultError(errorCode: string, errorMessage: string): ExecutorResult {
  return { exitCode: 1, signal: null, timedOut: false, errorCode, errorMessage };
}

function safeAbsolute(input: string): string {
  return path.resolve(input);
}

function inside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertCodexHome(config: CodexRuntimeConfig, env: NodeJS.ProcessEnv): string {
  if (!path.isAbsolute(config.codexHome)) throw new Error("codexHome 必须是绝对路径，请修改配置后重试。");
  const home = safeAbsolute(config.codexHome);
  const profile = env.USERPROFILE ?? env.HOME;
  if (profile && path.resolve(profile, ".codex").toLowerCase() === home.toLowerCase()) {
    throw new Error("codexHome 不能指向用户默认的 .codex 目录，请为成员代理配置独立目录。");
  }
  return home;
}

function prepareProcessEnvironment(env: NodeJS.ProcessEnv, serverUrl: string, codexHome: string): void {
  for (const key of Object.keys(env)) {
    if (PROCESS_ENV_ALLOWLIST.has(key)) continue;
    delete env[key];
  }
  env.PAPERCLIP_API_URL = serverUrl;
  env.CODEX_HOME = codexHome;
  // The adapter's auth cache is global to the host by default. A member agent
  // owns its separate CODEX_HOME and must not vend or copy credentials through
  // that shared cache.
}

function runtimeEntry(runtimeDir: string): string {
  return path.join(runtimeDir, "server", "dist", "codex-local.mjs");
}

async function checkRuntimeFiles(config: CodexRuntimeConfig, dependencies: CodexExecutorDependencies): Promise<void> {
  if (!path.isAbsolute(config.runtimeDir)) throw new Error("runtimeDir 必须是绝对路径，请运行 build-runtime 并更新配置。");
  const root = path.resolve(config.runtimeDir);
  const paths = [runtimeEntry(root), ...REQUIRED_ASSETS.map((item) => path.join(root, item)), path.join(root, "skills", "paperclip")];
  for (const candidate of paths) {
    try { await (dependencies.access ?? access)(candidate); }
    catch { throw new Error("Codex 运行时文件不完整，请重新运行 build-runtime 并将 runtimeDir 指向完整的 runtime 目录。"); }
  }
  const skillsStat = await (dependencies.stat ?? stat)(path.join(root, "skills", "paperclip")).catch(() => null);
  if (!skillsStat?.isDirectory()) throw new Error("Codex 运行时缺少 skills/paperclip 目录，请重新运行 build-runtime。");
}

async function loadRuntime(config: CodexRuntimeConfig, dependencies: CodexExecutorDependencies): Promise<CodexModule> {
  const entry = runtimeEntry(path.resolve(config.runtimeDir));
  if (dependencies.loadRuntime) return dependencies.loadRuntime(entry);
  if (cachedRuntime && cachedRuntimePath === entry) return cachedRuntime;
  const imported = await import(pathToFileURL(entry).href) as CodexModule;
  if (typeof imported.execute !== "function") throw new Error("Codex 运行时入口无效。");
  cachedRuntime = imported;
  cachedRuntimePath = entry;
  return imported;
}

function rewriteRuntime(job: JobStart, cwd: string): Record<string, unknown> {
  const runtime = { ...job.runtime };
  if (isRecord(runtime.sessionParams)) runtime.sessionParams = { ...runtime.sessionParams, cwd };
  else runtime.sessionParams = { cwd };
  return runtime;
}

function buildRuntimeToolEnv(job: JobStart, serverUrl: string): Record<string, string> {
  const access = job.runtimeTools;
  if (!access) return {};
  return {
    PAPERCLIP_RUNTIME_TOOLS_MCP_URL: rebaseEndpoint(access.mcpEndpoint, serverUrl),
    PAPERCLIP_RUNTIME_TOOLS_TOKEN: access.bearerToken,
    PAPERCLIP_RUNTIME_TOOLS_EXPIRES_AT: access.expiresAt,
    PAPERCLIP_RUNTIME_TOOLS_CONNECTIONS_SEARCH_URL: rebaseEndpoint(access.rest.connectionsSearch, serverUrl),
    PAPERCLIP_RUNTIME_TOOLS_CONNECTION_REQUEST_URL: rebaseEndpoint(access.rest.connectionRequest, serverUrl),
    PAPERCLIP_RUNTIME_TOOLS_AVAILABLE: access.tools.join(","),
    PAPERCLIP_RUNTIME_TOOLS_GUIDANCE: access.guidance,
  };
}

function addPaperclipRestGuidance(context: Record<string, unknown>, codexHome: string): void {
  const skillPath = path.join(codexHome, "skills", "paperclip", "SKILL.md");
  const guidance = [
    "## 成员运行的 Paperclip 操作方式",
    "本成员运行没有 Paperclip 原生工具。评论、确认卡、报告和状态变更必须通过普通 HTTP 接口操作；不能因为缺少原生工具而声称无法操作 Paperclip。",
    `每次运行先读取本机技能文档：Get-Content -LiteralPath '${skillPath.replaceAll("'", "''")}'。接口、审批和任务操作规则以该文档为准；继续遵守任务权限、审批与阻塞条件。`,
    "使用 PowerShell Invoke-RestMethod。服务根地址取 $env:PAPERCLIP_API_URL，运行令牌只从 $env:PAPERCLIP_API_KEY 读取，当前运行编号取 $env:PAPERCLIP_RUN_ID。",
    "$headers = @{ Authorization = ('Bearer ' + $env:PAPERCLIP_API_KEY); 'X-Paperclip-Run-Id' = $env:PAPERCLIP_RUN_ID }",
    "例如读取当前任务：Invoke-RestMethod -Method Get -Uri ($env:PAPERCLIP_API_URL.TrimEnd('/') + '/api/issues/' + $env:PAPERCLIP_TASK_ID) -Headers $headers。评论使用 POST /api/issues/{id}/comments，状态使用 PATCH /api/issues/{id}；JSON 请求设置 Content-Type: application/json。",
    "所有任务写操作都携带上述认证与 X-Paperclip-Run-Id 请求头；只引用环境变量，绝不打印、复制到文档或硬编码任何凭据。若旧历史或恢复文字提及当前不存在的控制接口，按本段与技能文档使用普通 HTTP 接口完成已授权操作。",
  ].join("\n");
  const task = typeof context.paperclipTaskMarkdown === "string" ? context.paperclipTaskMarkdown : "";
  const assignment = typeof context.paperclipTaskMarkdownAssignment === "string" ? context.paperclipTaskMarkdownAssignment : task;
  // Both fresh and resumed adapter attempts select one of these carriers.
  // Communication guidance alone is omitted on resume, so it cannot own this contract.
  for (const [key, fallback] of [
    ["paperclipTaskMarkdown", task], ["paperclipTaskMarkdownAssignment", assignment],
    ["paperclipTaskMarkdownCompact", task], ["paperclipTaskMarkdownAssignmentCompact", assignment],
  ]) {
    const text = typeof context[key] === "string" ? context[key] as string : fallback;
    context[key] = [guidance, text].filter(Boolean).join("\n\n");
  }
}

function safeResult(input: unknown, warn: (message: string) => void): ExecutorResult {
  if (!isRecord(input)) return resultError("member_agent_executor_error", "Codex 适配器没有返回有效结果。");
  const unknownCount = Object.keys(input).filter((key) => !RESULT_FIELDS.has(key)).length;
  if (unknownCount) warn(`Codex 结果含 ${unknownCount} 个不支持字段，已丢弃。`);
  const result = Object.fromEntries(Object.entries(input).filter(([key]) => RESULT_FIELDS.has(key))) as unknown as ExecutorResult;
  if (typeof result.exitCode !== "number" && result.exitCode !== null) {
    return resultError("member_agent_executor_error", "Codex 适配器返回的退出码无效。");
  }
  if (result.exitCode !== 0 && !result.errorCode) result.errorCode = "member_agent_codex_failed";
  return result;
}

function coded(error: unknown): { code?: string; message: string } {
  const value = error as { code?: unknown; message?: unknown };
  return { code: typeof value?.code === "string" ? value.code : undefined, message: typeof value?.message === "string" ? value.message : "" };
}

async function executeCodex(hooks: ExecutorHooks, config: CodexRuntimeConfig, dependencies: CodexExecutorDependencies): Promise<ExecutorResult> {
  const warn = dependencies.warn ?? ((message) => hooks.log("stderr", `警告：${message}\n`));
  const env = dependencies.processEnv ?? process.env;
  let cwd = "";
  let home = "";
  try {
    if (!path.isAbsolute(config.codexExecutable) || path.extname(config.codexExecutable).toLowerCase() !== ".exe") {
      throw Object.assign(new Error("codexExecutable 必须是绝对路径的 .exe 文件，请修改配置。"), { code: "member_agent_configuration_error" });
    }
    home = assertCodexHome(config, env);
    const resolved = await resolveLocalCwd(hooks.job.context, { ...config, codexHome: home, runtimeDir: path.resolve(config.runtimeDir) },
      { stat: dependencies.stat ?? stat });
    cwd = resolved.cwd;
  } catch (error) {
    const issue = coded(error);
    return resultError(issue.code ?? "member_agent_cwd_unresolved", issue.message || "无法解析项目本机目录，请检查项目目录映射。");
  }
  try {
    if (!await isCodexCodeModeHostReady(config.codexExecutable)) {
      return resultError("member_agent_runtime_missing", CODE_MODE_HOST_RECOVERY);
    }
    await checkRuntimeFiles(config, dependencies);
  } catch (error) {
    return resultError("member_agent_runtime_missing", coded(error).message || "Codex 运行时缺失，请重新运行 build-runtime。");
  }
  if (hooks.signal.aborted) return resultError("cancelled", "任务已取消。");
  try {
    await (dependencies.mkdir ?? mkdir)(home, { recursive: true });
    const agentHome = path.join(config.configDir, "agents", hooks.job.agent.id, "home");
    await (dependencies.mkdir ?? mkdir)(agentHome, { recursive: true });
  } catch {
    return resultError("member_agent_configuration_error", "无法准备成员代理的本机目录，请检查路径与权限。");
  }
  try {
    await (dependencies.materializeSkills ?? materializeSkills)(path.resolve(config.runtimeDir), home);
  } catch {
    return resultError("member_agent_skill_install_failed", "无法安装 Paperclip 技能到成员 Codex Home，请检查目录权限并重新运行 build-runtime。");
  }

  const localized = localizeContext(hooks.job.context, cwd, path.join(config.configDir, "agents", hooks.job.agent.id, "home"));
  localized.context.runtimeToolDelivery = "environment";
  if (localized.suspectedServerPaths > 0) warn(`任务文本中检测到 ${localized.suspectedServerPaths} 处疑似服务器路径；未改写任务文本。`);
  addPaperclipRestGuidance(localized.context, home);
  prepareProcessEnvironment(env, hooks.serverUrl, home);

  let module: CodexModule;
  try { module = await loadRuntime(config, dependencies); }
  catch {
    return resultError("member_agent_runtime_missing", "无法加载 Codex 运行时，请重新运行 build-runtime 并检查 Node 版本。");
  }
  const extendedHooks = hooks as ExecutorHooks & {
    meta?: (meta: Record<string, unknown>) => void;
    usage?: (usage: Record<string, unknown>) => void;
    childSpawned?: (pid: number) => void;
  };
  const ctx: Record<string, unknown> = {
    runId: hooks.job.jobId,
    agent: { id: hooks.job.agent.id, companyId: hooks.job.companyId, name: hooks.job.agent.name, adapterType: "codex_local", adapterConfig: {} },
    runtime: rewriteRuntime(hooks.job, cwd),
    config: {
      engine: "cli",
      command: config.codexExecutable,
      cwd,
      timeoutSec: hooks.job.config.maxRunSec ?? 3600,
      graceSec: 20,
      env: { CODEX_HOME: home, ...buildRuntimeToolEnv(hooks.job, hooks.serverUrl) },
      extraArgs: [],
      managedAiConnection: true,
    },
    context: localized.context,
    executionTarget: { kind: "local" },
    authToken: hooks.job.authToken,
    getFreshSessionHandoff: async () => hooks.job.handoffMarkdown.trim() ? hooks.job.handoffMarkdown : null,
    onLog: hooks.log,
    onMeta: (value: Record<string, unknown>) => extendedHooks.meta?.(value),
    onEvent: hooks.event,
    onUsage: (value: Record<string, unknown>) => extendedHooks.usage?.(value),
    onSpawn: (metadata: unknown) => {
      if (isRecord(metadata) && Number.isSafeInteger(metadata.pid) && (metadata.pid as number) > 0) extendedHooks.childSpawned?.(metadata.pid as number);
    },
    onRuntimeProgress: () => undefined,
    signal: hooks.signal,
  };

  try {
    const result = safeResult(await module.execute(ctx), warn);
    return result;
  } catch {
    return resultError("member_agent_executor_error", "Codex 执行器发生错误，请检查本机日志。");
  }
}

export function createCodexExecutor(config: CodexRuntimeConfig, dependencies: CodexExecutorDependencies = {}): Executor {
  return { name: "codex", execute: (hooks) => executeCodex(hooks, config, dependencies) };
}
