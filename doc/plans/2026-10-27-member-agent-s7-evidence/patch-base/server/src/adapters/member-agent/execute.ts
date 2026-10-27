import { z } from "zod";
import type { AdapterExecutionContext, AdapterExecutionResult, AdapterInvocationMeta, AdapterRuntimeEvent, AdapterUsageCheckpoint } from "@paperclipai/adapter-utils";
import { createAgentIdentityRedactor } from "../../services/agent-identity-redaction.js";
import { memberAgentConnections, MEMBER_AGENT_MAX_FRAME_BYTES, type MemberFrame } from "../../realtime/member-agent-ws.js";
import { codeSyncDir } from "./settings.js";

const number = z.number().finite().nonnegative();
const usage = z.object({ inputTokens: number, outputTokens: number, cachedInputTokens: number.optional(), cacheWriteTokens: number.optional() }).strict();
const billingType = z.enum(["api", "subscription", "metered_api", "subscription_included", "subscription_overage", "credits", "fixed", "unknown"]);
const accounting = {
  usage: usage.optional(), usageByModel: z.array(z.object({ model: z.string(), usage, costUsd: number }).strict()).optional(),
  usageBasis: z.enum(["per_run", "session_cumulative"]).nullable().optional(),
  provider: z.string().nullable().optional(), biller: z.string().nullable().optional(), model: z.string().nullable().optional(), billingType: billingType.nullable().optional(),
  costUsd: number.nullable().optional(), costUsdExact: z.string().nullable().optional(),
  costStatus: z.enum(["reported", "estimated", "unpriced"]).optional(),
  pricingContext: z.object({ serviceTier: z.string().optional(), contextTier: z.enum(["short", "long"]).optional() }).strict().optional(),
  pricingProvenance: z.object({ source: z.enum(["provider_reported", "provider_invoice", "operator", "rate_card", "unknown"]), version: z.string().optional(), evidence: z.string().optional(), inputCentsPerMillion: z.string().optional(), cachedInputCentsPerMillion: z.string().optional(), outputCentsPerMillion: z.string().optional(), cacheWriteCentsPerMillion: z.string().optional(), serviceTier: z.string().optional(), contextTier: z.enum(["short", "long"]).optional() }).strict().optional(),
  cacheAdjustedCostUsd: number.nullable().optional(), providerRequestId: z.string().nullable().optional(),
};
const checkpoint = z.object({ ...accounting, attemptId: z.string().optional(), complete: z.boolean() }).strict();
const record = z.record(z.string(), z.unknown());
const resultSchema = z.object({
  ...accounting, exitCode: z.number().int().nullable(), signal: z.string().nullable(), timedOut: z.boolean(),
  errorCode: z.string().nullable().optional(), errorMessage: z.string().nullable().optional(),
  errorFamily: z.enum(["configuration", "transient_upstream", "provider_quota", "model_refusal", "refresh_token_reused", "refresh_token_expired", "refresh_token_invalidated"]).nullable().optional(),
  retryNotBefore: z.iso.datetime({ offset: true }).nullable().optional(), errorMeta: record.optional(),
  summary: z.string().nullable().optional(), resultJson: record.nullable().optional(),
  sessionId: z.string().nullable().optional(), sessionDisplayId: z.string().nullable().optional(), sessionParams: record.nullable().optional(),
  clearSession: z.boolean().optional(), usageComplete: z.boolean().optional(),
  executionRecovery: z.union([
    z.object({ kind: z.literal("bootstrap"), providerWorkStarted: z.literal(false) }).strict(),
    z.object({ kind: z.literal("interrupted"), providerStopped: z.literal(true), sessionPreserved: z.literal(true), actionOutcomes: z.literal("settled") }).strict(),
  ]).optional(),
}).strict();
const metaSchema = z.object({ adapterType: z.string(), command: z.string(), cwd: z.string().optional(), commandArgs: z.array(z.string()).optional(), commandNotes: z.array(z.string()).optional(), env: z.record(z.string(), z.string()).optional(), prompt: z.string().optional(), promptMetrics: z.record(z.string(), number).optional(), context: record.optional() }).strict();
const eventSchema = z.object({ eventType: z.string(), stream: z.enum(["system", "stdout", "stderr"]).optional(), level: z.enum(["info", "warn", "error"]).optional(), color: z.string().optional(), message: z.string().optional(), payload: record.optional() }).strict();
const CONTEXT_KEYS = ["issueId", "taskId", "projectId", "wakeReason", "wakeCommentId", "commentId", "approvalId", "approvalStatus", "issueIds", "conversationMode", "interactionResponses", "connectionInstructions", "paperclipWake", "paperclipWorkspace", "paperclipWorkspaces", "paperclipTaskMarkdown", "paperclipTaskMarkdownAssignment", "paperclipTaskMarkdownResume", "paperclipTaskCommunicationGuidance", "paperclipContinuationSummary", "paperclipSessionHandoffMarkdown"];

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const connection = memberAgentConnections.get(ctx.agent.companyId, ctx.agent.id);
  const redact = createAgentIdentityRedactor();
  redact.register(ctx.authToken, ctx.runtimeTools?.bearerToken, connection?.credential);
  // JSON-level redaction also protects property names from credential echoes.
  const clean = <T>(value: T): T => JSON.parse(redact.redact(JSON.stringify(value))) as T;
  const failure = (errorCode: string, errorMessage: string, timedOut = false): AdapterExecutionResult => ({ exitCode: 1, signal: null, timedOut, errorCode, errorMessage });
  const busy = (): AdapterExecutionResult => ({
    ...failure("member_agent_busy", "该成员智能体正在执行其他任务，将稍后自动重试"),
    errorFamily: "transient_upstream",
    retryNotBefore: new Date(Date.now() + 30000).toISOString(),
    // No work started for this refused job. The heartbeat scheduler requires
    // this existing recovery proof before it may retry a failed legacy run.
    executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
  });
  const report = async (result: AdapterExecutionResult) => {
    const safe = clean(result);
    if (safe.timedOut || safe.errorCode || safe.exitCode !== 0) {
      safe.errorCode ||= safe.timedOut ? "member_agent_timeout" : "member_agent_failed";
      safe.errorMessage ||= "成员智能体执行失败";
      await ctx.onLog("stderr", `${safe.errorCode}: ${safe.errorMessage}\n`);
    }
    return safe;
  };
  if (!connection) return report(failure("member_agent_offline", "该成员智能体当前不在线"));
  if (connection.currentJobId) return report(busy());
  if (!ctx.authToken?.trim()) return report(failure("member_agent_no_token", "本次运行缺少运行令牌，未派发任务"));
  const maxRunSec = ctx.config.maxRunSec ?? 3600;
  if (typeof maxRunSec !== "number" || !Number.isInteger(maxRunSec) || maxRunSec < 1 || maxRunSec > 14400
    || (ctx.config.extraArgs !== undefined && (!Array.isArray(ctx.config.extraArgs) || ctx.config.extraArgs.length > 0))) {
    return report(failure("member_agent_invalid_config", "maxRunSec 必须为 1 至 14400 秒；阶段 1 不接受额外工具参数"));
  }
  connection.currentJobId = ctx.runId;
  let accepted = false, settled = false, resultSeen = false, sent = false;
  let logSeq = 0, eventSeq = 0, pendingFrames = 0;
  let queue = Promise.resolve();
  let acceptTimer: ReturnType<typeof setTimeout> | undefined;
  let runTimer: ReturnType<typeof setTimeout> | undefined;
  let cancelTimer: ReturnType<typeof setTimeout> | undefined;
  let stopReason: "cancelled" | "member_agent_timeout" | null = null;
  let resolve!: (result: AdapterExecutionResult) => void;
  const completed = new Promise<AdapterExecutionResult>(done => { resolve = done; });
  const settle = (result: AdapterExecutionResult) => {
    if (settled) return;
    settled = true; clearTimeout(acceptTimer); clearTimeout(runTimer); clearTimeout(cancelTimer);
    resolve(result);
  };
  const fail = (code: string, message: string) => settle(failure(code, message));
  const stopReceipt = (proof: "member_agent_stop_result" | "member_agent_not_dispatched") => ({
    executionCancellation: { state: "acknowledged", acknowledgedAt: new Date().toISOString(), proof,
      companyId: ctx.agent.companyId, agentId: ctx.agent.id, runId: ctx.runId },
  });
  const send = (frame: MemberFrame) => {
    const json = JSON.stringify({ v: 1, ...frame });
    if (Buffer.byteLength(json) > MEMBER_AGENT_MAX_FRAME_BYTES) throw new Error("member_agent_payload_too_large");
    connection.socket.send(json);
  };
  const cancel = (reason: "cancelled" | "member_agent_timeout") => {
    if (settled || stopReason) return;
    stopReason = reason;
    if (!sent) {
      const result = failure(reason, reason === "cancelled" ? "运行已取消，未派发任务" : "成员运行准备超时", reason !== "cancelled");
      // The server can prove no provider work was dispatched in this branch.
      if (reason === "cancelled") result.resultJson = stopReceipt("member_agent_not_dispatched");
      settle(result); return;
    }
    clearTimeout(acceptTimer);
    try { send({ type: "job.cancel", jobId: ctx.runId, graceSec: 20 }); }
    catch { settle(failure(reason, "取消请求无法送达成员智能体", reason !== "cancelled")); return; }
    cancelTimer = setTimeout(() => settle(failure(reason, "等待成员停止确认超时；未确认本机进程已停止", reason !== "cancelled")), 30000);
  };
  const onAbort = () => cancel("cancelled");
  const receive = async (frame: MemberFrame) => {
    if (settled) return;
    if (frame.type === "job.accepted") { accepted = true; clearTimeout(acceptTimer); return; }
    if (!accepted) {
      // A busy member refuses admission before acknowledging preparation.
      // Only this exact terminal refusal proves the job did not start.
      if (!stopReason && frame.type === "job.result") {
        const { v: _v, type: _type, jobId: _jobId, ...payload } = frame;
        const parsed = resultSchema.safeParse(payload);
        if (parsed.success && parsed.data.errorCode === "member_agent_busy" && parsed.data.exitCode === 1
          && parsed.data.signal === null && parsed.data.timedOut === false) {
          settle(busy()); return;
        }
      }
      fail("member_agent_protocol_error", "成员必须先确认 job.accepted"); return;
    }
    if (frame.type === "job.log") {
      if (!Number.isSafeInteger(frame.seq) || (frame.seq as number) < 1 || !["stdout", "stderr"].includes(String(frame.stream)) || typeof frame.chunk !== "string" || Buffer.byteLength(frame.chunk) > 32 * 1024) {
        fail("member_agent_protocol_error", "成员日志消息无效"); return;
      }
      if ((frame.seq as number) <= logSeq) return;
      logSeq = frame.seq as number;
      const chunk = redact.chunk(frame.stream as string, frame.chunk);
      if (chunk) await ctx.onLog(frame.stream as "stdout" | "stderr", chunk);
    } else if (frame.type === "job.meta") {
      const parsed = metaSchema.safeParse(frame.meta);
      if (!parsed.success) { fail("member_agent_protocol_error", "成员调用元数据无效"); return; }
      await ctx.onMeta?.(clean(parsed.data) as AdapterInvocationMeta);
    } else if (frame.type === "job.event") {
      const parsed = eventSchema.safeParse(frame.event);
      if (!parsed.success || !Number.isSafeInteger(frame.seq) || (frame.seq as number) < 1) { fail("member_agent_protocol_error", "成员运行事件无效"); return; }
      if ((frame.seq as number) <= eventSeq) return;
      eventSeq = frame.seq as number;
      await ctx.onEvent?.(clean(parsed.data) as AdapterRuntimeEvent);
    } else if (frame.type === "job.usage") {
      const parsed = checkpoint.safeParse(frame.usage);
      if (!parsed.success) { fail("member_agent_protocol_error", "成员用量消息无效"); return; }
      await ctx.onUsage?.(clean(parsed.data) as AdapterUsageCheckpoint);
    } else if (frame.type === "job.result") {
      const { v: _v, type: _type, jobId: _jobId, ...payload } = frame;
      const parsed = resultSchema.safeParse(payload);
      if (!parsed.success) { fail("member_agent_protocol_error", "成员运行结果无效"); return; }
      const result: AdapterExecutionResult = parsed.data;
      // Stop admission belongs to the server, never to opaque provider output.
      if (result.resultJson && Object.hasOwn(result.resultJson, "executionCancellation")) {
        const { executionCancellation: _untrustedStopReceipt, ...output } = result.resultJson;
        result.resultJson = output;
      }
      if (stopReason) {
        // The member runner emits this terminal result only after its worker and
        // registered process trees have stopped. Cleanup failures have a distinct
        // error code and must never become a successful Stop acknowledgement.
        const confirmed = result.errorCode === "cancelled" && result.exitCode === 1 && result.signal === null && !result.timedOut;
        const cleanupFailed = result.errorCode && result.errorCode !== "cancelled" && result.errorCode !== "member_agent_timeout";
        if (confirmed && stopReason === "cancelled") {
          result.resultJson = { ...result.resultJson, ...stopReceipt("member_agent_stop_result") };
        }
        if (!cleanupFailed) {
          result.errorCode = stopReason;
          result.errorMessage = stopReason === "cancelled" ? "运行已取消" : "成员运行超过总时长上限";
          if (!confirmed) result.errorMessage += "；未确认本机进程已停止";
        }
        result.timedOut = stopReason !== "cancelled";
        result.exitCode = 1;
      }
      settle(result);
    }
  };
  connection.job = { id: ctx.runId, fail, receive(frame) {
    if (settled || resultSeen) return;
    if (frame.type === "job.result") resultSeen = true;
    if (++pendingFrames > 1000) { fail("member_agent_protocol_error", "成员消息队列超过上限"); return; }
    queue = queue.then(() => receive(frame)).catch(() => fail("member_agent_callback_failed", "处理成员运行消息失败"))
      .finally(() => { pendingFrames--; });
  } };
  try {
    ctx.signal?.addEventListener("abort", onAbort, { once: true });
    if (ctx.signal?.aborted) onAbort();
    runTimer = setTimeout(() => cancel("member_agent_timeout"), maxRunSec * 1000);
    if (!settled) await Promise.race([Promise.resolve().then(() => ctx.onCancellationReady?.()), completed]);
    if (!settled) {
      const preparation = (async () => {
        let handoff: string;
        try {
          const generated = ctx.getFreshSessionHandoff ? await ctx.getFreshSessionHandoff() : ctx.context.paperclipFreshSessionHandoffMarkdown;
          handoff = typeof generated === "string" ? generated : "";
        } catch {
          fail("member_agent_dispatch_failed", "生成历史摘要出错");
          return;
        }
        if (settled) return;
        const context = Object.fromEntries(CONTEXT_KEYS.filter(key => ctx.context[key] !== undefined).map(key => [key, ctx.context[key]]));
        let handoffMarkdown = handoff;
        if (Buffer.byteLength(handoffMarkdown, "utf8") > 24000) {
          const marker = "[更早的历史已省略]\n";
          const remainingBytes = 24000 - Buffer.byteLength(marker, "utf8");
          const suffix: string[] = [];
          let suffixBytes = 0;
          for (const character of Array.from(handoffMarkdown).reverse()) {
            const characterBytes = Buffer.byteLength(character, "utf8");
            if (suffixBytes + characterBytes > remainingBytes) break;
            suffix.push(character);
            suffixBytes += characterBytes;
          }
          handoffMarkdown = marker + suffix.reverse().join("");
        }
        send({ type: "job.start", jobId: ctx.runId, companyId: ctx.agent.companyId, agent: { id: ctx.agent.id, name: ctx.agent.name },
          authToken: ctx.authToken, config: { maxRunSec }, context: clean(context),
          runtime: clean({ sessionId: ctx.runtime.sessionId, sessionDisplayId: ctx.runtime.sessionDisplayId, sessionParams: ctx.runtime.sessionParams, taskKey: ctx.runtime.taskKey }),
          runtimeTools: ctx.runtimeTools ? { version: ctx.runtimeTools.version, guidance: ctx.runtimeTools.guidance, mcpEndpoint: ctx.runtimeTools.mcpEndpoint, rest: { ...ctx.runtimeTools.rest }, bearerToken: ctx.runtimeTools.bearerToken, expiresAt: ctx.runtimeTools.expiresAt, tools: [...ctx.runtimeTools.tools] } : null,
          handoffMarkdown: clean(handoffMarkdown), codeSyncDir,
        });
        sent = true;
        acceptTimer = setTimeout(() => fail("member_agent_not_accepted", "成员未在五秒内确认任务"), 5000);
        ctx.onDispatch?.();
      })();
      await Promise.race([preparation, completed]);
      void preparation.catch(() => fail("member_agent_dispatch_failed", "派发成员任务失败"));
    }
    return await report(await completed);
  } catch {
    return await report(failure("member_agent_dispatch_failed", "派发成员任务失败"));
  } finally {
    clearTimeout(acceptTimer); clearTimeout(runTimer); clearTimeout(cancelTimer);
    ctx.signal?.removeEventListener("abort", onAbort);
    // Drop held secret prefixes; never flush a credential fragment at shutdown.
    redact.finish("stdout"); redact.finish("stderr");
    if (connection.currentJobId === ctx.runId) { connection.currentJobId = null; connection.job = null; }
  }
}
