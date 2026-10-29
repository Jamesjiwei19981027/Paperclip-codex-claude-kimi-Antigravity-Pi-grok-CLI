import path from "node:path";
import type { ExecutorResult, JobStart } from "./types.ts";
import { isRecord, rebaseEndpoint } from "./shared-support.ts";
import { redactProxyAddress } from "./codex-proxy.ts";

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

export function resultError(errorCode: string, errorMessage: string): ExecutorResult {
  return { exitCode: 1, signal: null, timedOut: false, errorCode, errorMessage };
}

export function prepareProcessEnvironment(env: NodeJS.ProcessEnv, serverUrl: string, codexHome?: string): void {
  for (const key of Object.keys(env)) {
    if (PROCESS_ENV_ALLOWLIST.has(key)) continue;
    delete env[key];
  }
  env.PAPERCLIP_API_URL = serverUrl;
  if (codexHome !== undefined) env.CODEX_HOME = codexHome;
  // The adapter's auth cache is global to the host by default. A member agent
  // owns its separate CODEX_HOME and must not vend or copy credentials through
  // that shared cache.
}

export function rewriteRuntime(job: JobStart, cwd: string): Record<string, unknown> {
  const runtime = { ...job.runtime };
  if (isRecord(runtime.sessionParams)) runtime.sessionParams = { ...runtime.sessionParams, cwd };
  else runtime.sessionParams = { cwd };
  return runtime;
}

export function buildRuntimeToolEnv(job: JobStart, serverUrl: string): Record<string, string> {
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

export function addPaperclipRestGuidance(context: Record<string, unknown>, codexHome: string): void {
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

export function safeResult(input: unknown, warn: (message: string) => void, label = "Codex"): ExecutorResult {
  if (!isRecord(input)) return resultError("member_agent_executor_error", `${label} 适配器没有返回有效结果。`);
  const unknownCount = Object.keys(input).filter((key) => !RESULT_FIELDS.has(key)).length;
  if (unknownCount) warn(`${label} 结果含 ${unknownCount} 个不支持字段，已丢弃。`);
  const result = Object.fromEntries(Object.entries(input).filter(([key]) => RESULT_FIELDS.has(key))) as unknown as ExecutorResult;
  if (typeof result.exitCode !== "number" && result.exitCode !== null) {
    return resultError("member_agent_executor_error", `${label} 适配器返回的退出码无效。`);
  }
  if (result.exitCode !== 0 && !result.errorCode) result.errorCode = label === "Codex" ? "member_agent_codex_failed" : "member_agent_codebuddy_failed";
  return result;
}


export function createOutputRedactor(proxyEnv: Record<string, string>) {
  const proxyAddresses = Object.entries(proxyEnv).filter(([key, value]) => /^(https?|all)_proxy$/i.test(key) && value.includes("@")).map(([, value]) => value);
  const redactText = (text: string) => proxyAddresses.reduce((safe, value) => safe.replaceAll(value, redactProxyAddress(value)), text);
  const redactOutput = (value: unknown): unknown => {
    if (typeof value === "string") return redactText(value);
    if (Array.isArray(value)) return value.map(redactOutput);
    if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactOutput(item)]));
    return value;
  };
  return { redactText, redactOutput };
}
