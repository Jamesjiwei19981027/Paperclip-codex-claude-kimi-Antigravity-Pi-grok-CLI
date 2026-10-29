import { access, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { readWindowsProcessIdentity, terminateRecordedProcess, type ProcessIdentity } from "../process-tree.ts";
import type { Executor, ExecutorHooks, ExecutorResult } from "./types.ts";
import { assertIsolatedConfigHome, isRecord, localizeContext, materializeSkills, resolveLocalCwd } from "./shared-support.ts";
import { addPaperclipRestGuidance, buildRuntimeToolEnv, createOutputRedactor, prepareProcessEnvironment, resultError, rewriteRuntime, safeResult } from "./shared-runtime.ts";
import { resolveCodexProxy } from "./codex-proxy.ts";
import { writeCodeBuddyShim } from "./codebuddy-launcher.ts";

export interface CodeBuddyRuntimeConfig {
  codebuddyEntry: string;
  codebuddyHome: string;
  codebuddyModel?: string;
  runtimeDir: string;
  projectDirs: Record<string, unknown>;
  defaultCwd: string;
  configDir: string;
  proxyWarningState?: SharedArrayBuffer;
}
export interface CodeBuddyDependencies {
  processEnv?: NodeJS.ProcessEnv;
  loadRuntime?: (entry: string) => Promise<{ execute(ctx: Record<string, unknown>): Promise<unknown> }>;
  queryRegistry?: () => Promise<string>;
}

export function normalizeCodeBuddyResult(result: ExecutorResult, model: string, sawAssistant = false): ExecutorResult {
  const terminal = isRecord(result.resultJson) ? result.resultJson : {};
  // The reused Claude parser scans tool output too (e.g. "unauthorized recipients"
  // in SKILL.md). Only an explicit clean CodeBuddy success overrides that heuristic.
  if (result.errorCode === "claude_auth_required") {
    if (terminal.type === "result" && terminal.subtype === "success" && terminal.is_error !== true
      && result.exitCode === 0 && !result.timedOut && !result.signal) {
      for (const key of ["errorCode", "errorMessage", "errorFamily", "errorMeta", "retryNotBefore", "loginUrl"]) Reflect.deleteProperty(result, key);
    } else {
      result.errorCode = "member_agent_codebuddy_login_required";
      result.errorFamily = "configuration";
      result.errorMessage = "请在本机运行 start.ps1 -Mode login（或打开 CodeBuddy 登录一次）后重试";
      delete result.errorMeta;
    }
  }
  // CodeBuddy can append another init after result; the terminal session wins.
  const session = typeof terminal.session_id === "string" ? terminal.session_id : null;
  if (session) {
    result.sessionId = result.sessionDisplayId = session;
    if (isRecord(result.sessionParams)) result.sessionParams = { ...result.sessionParams, sessionId: session };
  }
  if (terminal.is_error === true) {
    if (result.exitCode === 0) result.exitCode = 1;
    const errors = JSON.stringify([terminal.errors, terminal.result, result.errorMessage]);
    if (/authentication required|not logged in|please.*(?:\/login|log in)|login required/i.test(errors)) {
      result.errorCode = "member_agent_codebuddy_login_required";
      result.errorFamily = "configuration";
      result.errorMessage = "请在本机运行 start.ps1 -Mode login（或打开 CodeBuddy 登录一次）后重试";
      delete result.errorMeta;
    } else if (/model[\s\S]{0,180}(?:service info not found|not found|unavailable|not available|does not exist|invalid)|unknown model/i.test(errors)) {
      result.errorCode = "member_agent_configuration_error";
      result.errorFamily = "configuration";
      result.errorMessage = `CodeBuddy 模型 ${model || "（账号默认）"} 不可用，请修改 codebuddyModel 后重试。`;
    } else {
      result.errorCode ||= "member_agent_codebuddy_failed";
      result.errorMessage ||= typeof terminal.result === "string" && terminal.result ? terminal.result : Array.isArray(terminal.errors) ? terminal.errors.map(String).join("\n") : "CodeBuddy 执行失败。";
    }
  }
  if (result.exitCode === 0 && !result.errorCode && !result.timedOut && !result.signal
    && terminal.type === "result" && !String(terminal.result ?? "").trim() && !result.summary?.trim()
    && result.usage?.inputTokens === 0 && result.usage?.outputTokens === 0 && !sawAssistant) {
    result.exitCode = 1;
    result.errorCode = "member_agent_codebuddy_empty_run";
    result.errorMessage = "CodeBuddy 未收到任务内容或未执行，请重试；如反复出现请把日志发给负责人。";
  }
  // The reused parser reports Claude billing identity. CodeBuddy owns this run.
  if (result.provider) result.provider = "tencent";
  if (result.biller) result.biller = "tencent";
  if (/^claude-/i.test(result.model ?? "")) result.model = model || null;
  return result;
}

export function createCodeBuddyExecutor(config: CodeBuddyRuntimeConfig, dependencies: CodeBuddyDependencies = {}): Executor {
  return { name: "codebuddy", execute: async (hooks: ExecutorHooks): Promise<ExecutorResult> => {
    const env = dependencies.processEnv ?? process.env;
    const warn = (message: string) => hooks.log("stderr", `警告：${message}\n`);
    const model = config.codebuddyModel?.trim() ?? "";
    const home = path.resolve(config.codebuddyHome);
    const entry = path.join(config.runtimeDir, "server/dist/claude-local.mjs");
    let cwd: string;
    try {
      if (!path.isAbsolute(config.codebuddyEntry) || !path.isAbsolute(config.codebuddyHome) || !path.isAbsolute(config.runtimeDir)
        || /^claude-/i.test(model) || ((env.USERPROFILE ?? env.HOME) && home.toLowerCase() === path.resolve((env.USERPROFILE ?? env.HOME)!, ".codebuddy").toLowerCase())) {
        return resultError("member_agent_configuration_error", "请检查 codebuddyEntry、codebuddyHome、codebuddyModel 与 runtimeDir；不得使用个人 .codebuddy 目录或 claude-* 模型。");
      }
      await assertIsolatedConfigHome(home, path.join(env.USERPROFILE ?? env.HOME ?? homedir(), ".codebuddy"));
      const resolved = await resolveLocalCwd(hooks.job.context, { ...config, codexHome: home, additionalForbiddenDirs: [path.join(env.USERPROFILE ?? env.HOME ?? homedir(), ".codebuddy")] }, { stat });
      cwd = resolved.cwd;
    } catch (error) {
      return resultError((error as { code?: string }).code ?? "member_agent_cwd_unresolved", error instanceof Error ? error.message : "无法解析本机目录。");
    }
    try { await access(config.codebuddyEntry); await access(entry); await access(path.join(config.runtimeDir, "skills/paperclip/SKILL.md")); }
    catch { return resultError("member_agent_runtime_missing", "CodeBuddy 入口或运行时不完整，请重新获取安装包或运行 build-runtime。"); }
    if (hooks.signal.aborted) return resultError("cancelled", "任务已取消。");
    const agentHome = path.join(config.configDir, "agents", hooks.job.agent.id, "home");
    let command: string;
    try {
      await mkdir(agentHome, { recursive: true });
      await materializeSkills(config.runtimeDir, home);
      command = await writeCodeBuddyShim(path.join(home, "member-launcher"));
    } catch { return resultError("member_agent_configuration_error", "无法准备 CodeBuddy 专属目录、技能与启动器，请检查目录权限。"); }
    const localized = localizeContext(hooks.job.context, cwd, agentHome);
    localized.context.runtimeToolDelivery = "environment";
    if (localized.suspectedServerPaths) warn(`任务文本中检测到 ${localized.suspectedServerPaths} 处疑似服务器路径；未改写任务文本。`);
    addPaperclipRestGuidance(localized.context, home);
    for (const key of ["paperclipTaskMarkdown", "paperclipTaskMarkdownAssignment", "paperclipTaskMarkdownCompact", "paperclipTaskMarkdownAssignmentCompact"]) {
      const text = localized.context[key];
      if (typeof text === "string") {
        localized.context[key] = "Windows PowerShell 5.1 调用 Paperclip API 发送含中文的 JSON 时，用 [Text.Encoding]::UTF8.GetBytes($json) 作为 -Body，并设 -ContentType 'application/json; charset=utf-8'，避免中文变成问号。\n\n" + text;
      }
    }
    const proxy = await resolveCodexProxy({ env, serverUrl: hooks.serverUrl, queryRegistry: dependencies.queryRegistry, registryWarningState: config.proxyWarningState, warn });
    hooks.log("stdout", `${proxy.message}\n`);
    const { redactText, redactOutput } = createOutputRedactor(proxy.env);
    prepareProcessEnvironment(env, hooks.serverUrl);
    // These are adapter state paths, not HOME/USERPROFILE overrides. The CLI
    // continues to share the member's CodeBuddy/extension login identity.
    env.PAPERCLIP_HOME = path.join(home, "paperclip-runtime");
    env.CLAUDE_CONFIG_DIR = home;
    let module: { execute(ctx: Record<string, unknown>): Promise<unknown> };
    try { module = await (dependencies.loadRuntime ? dependencies.loadRuntime(entry) : import(pathToFileURL(entry).href)); }
    catch { return resultError("member_agent_runtime_missing", "无法加载 Claude CLI 运行时，请重新构建 runtime 并检查 Node 版本。"); }
    const identities: ProcessIdentity[] = [];
    const identityPending = new Set<Promise<void>>();
    let idleTimeout = false;
    let stopping: Promise<void> | undefined;
    const stop = () => stopping ??= (async () => {
      await Promise.all([...identityPending]);
      await Promise.all(identities.map(identity => terminateRecordedProcess(identity, true).catch(() => warn("进程树清理失败，将由成员代理兜底清理。"))));
    })();
    const abort = () => { void stop(); };
    let idle: ReturnType<typeof setTimeout>;
    const armIdle = () => { clearTimeout(idle); idle = setTimeout(() => { idleTimeout = true; void stop(); }, 15 * 60_000); };
    hooks.signal.addEventListener("abort", abort, { once: true });
    armIdle();
    let sawAssistant = false;
    let stdoutPending = "";
    const inspectStdout = (text: string) => {
      stdoutPending += text;
      const lines = stdoutPending.split("\n"); stdoutPending = lines.pop() ?? "";
      for (const line of lines) {
        try { if (JSON.parse(line).type === "assistant") sawAssistant = true; } catch { /* Non-JSON diagnostics. */ }
      }
    };
    const ctx: Record<string, unknown> = {
      runId: hooks.job.jobId,
      agent: { id: hooks.job.agent.id, companyId: hooks.job.companyId, name: hooks.job.agent.name, adapterType: "claude_local", adapterConfig: {} },
      runtime: rewriteRuntime(hooks.job, cwd),
      config: {
        engine: "cli", command, cwd, model, managedAiConnection: true, dangerouslySkipPermissions: true,
        timeoutSec: hooks.job.config.maxRunSec ?? 3600, graceSec: 20,
        env: { CODEBUDDY_CONFIG_DIR: home, CLAUDE_CONFIG_DIR: home,
          PAPERCLIP_CODEBUDDY_ENTRY: config.codebuddyEntry, PAPERCLIP_CODEBUDDY_MODEL: model,
          PATH: `${path.dirname(process.execPath)}${path.delimiter}${env.PATH ?? env.Path ?? ""}`,
          ...proxy.env, ...buildRuntimeToolEnv(hooks.job, hooks.serverUrl) },
        extraArgs: [],
      },
      context: localized.context, executionTarget: { kind: "local" }, authToken: hooks.job.authToken,
      getFreshSessionHandoff: async () => hooks.job.handoffMarkdown.trim() || null,
      onLog: async (stream: "stdout" | "stderr", text: string) => { if (text) armIdle(); if (stream === "stdout") inspectStdout(text); hooks.log(stream, redactText(text)); },
      onMeta: async (value: Record<string, unknown>) => { hooks.meta?.(redactOutput(value) as Record<string, unknown>); },
      onEvent: async (value: Record<string, unknown>) => { hooks.event(redactOutput(value) as Record<string, unknown>); },
      onUsage: async (value: Record<string, unknown>) => { hooks.usage?.({ ...value, provider: "tencent", biller: "tencent" }); },
      onSpawn: async (metadata: unknown) => {
        if (isRecord(metadata) && Number.isSafeInteger(metadata.pid) && (metadata.pid as number) > 0) {
          hooks.childSpawned?.(metadata.pid as number);
          const pending = readWindowsProcessIdentity(metadata.pid as number).then(identity => { if (identity) identities.push(identity); }).catch(() => warn("无法记录 CodeBuddy 进程身份，将由成员代理兜底清理。"));
          identityPending.add(pending);
          await pending; identityPending.delete(pending);
          if (hooks.signal.aborted || idleTimeout) { stopping = undefined; void stop(); }
        }
      },
      onRuntimeProgress: () => undefined,
    };
    try {
      if (hooks.signal.aborted) return resultError("cancelled", "任务已取消。");
      const rawResult = await module.execute(ctx);
      inspectStdout("\n"); // Also inspect the final line without a trailing newline.
      const result = normalizeCodeBuddyResult(safeResult(redactOutput(rawResult), warn, "CodeBuddy"), model, sawAssistant);
      if (idleTimeout) return { ...result, exitCode: 1, timedOut: true, errorCode: "member_agent_timeout", errorMessage: "CodeBuddy 已连续 15 分钟无输出，运行已停止。" };
      if (hooks.signal.aborted) return { ...result, exitCode: 1, errorCode: "cancelled", errorMessage: "任务已取消。" };
      return result;
    } catch { return resultError("member_agent_executor_error", "CodeBuddy 执行器发生错误，请检查本机日志。"); }
    finally { clearTimeout(idle!); hooks.signal.removeEventListener("abort", abort); await stop(); }
  } };
}
