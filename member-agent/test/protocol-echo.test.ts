import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { hostname } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { chunkUtf8, parseFrame, validateEvent, validateMeta, validateResult, validateUsage } from "../src/protocol.ts";
import { AGENT_VERSION, echoExecutor } from "../src/executors/echo.ts";
import type { ExecutorHooks, JobStart } from "../src/executors/types.ts";

const success = { exitCode: 0, signal: null, timedOut: false };

describe("protocol frames and UTF-8 output", () => {
  it("parses a UTF-8 text frame and preserves unknown types for caller logging", () => {
    expect(parseFrame(Buffer.from('{"v":1,"type":"future.type","message":"中文"}'))).toEqual({ v: 1, type: "future.type", message: "中文" });
  });
  it.each(["not json", "null", "[]", '{"type":"ping"}', '{"v":2,"type":"ping"}', '{"v":1,"type":1}'])
    ("rejects malformed envelopes: %s", (frame) => expect(() => parseFrame(frame)).toThrow());
  it("rejects binary and oversized frames without echoing their contents", () => {
    expect(() => parseFrame('{"v":1,"type":"ping"}', true)).toThrow();
    expect(() => parseFrame(JSON.stringify({ v: 1, type: "ping", data: "字".repeat(100_000) }))).toThrow();
    expect(() => parseFrame('{"fake-secret-token"')).toThrow(/^(?!.*fake-secret-token)/);
  });
  it("accepts exactly 256 KiB and rejects one byte more", () => {
    const base = JSON.stringify({ v: 1, type: "ping", data: "" });
    const frame = base.replace('"data":""', '"data":"' + "a".repeat(256 * 1024 - Buffer.byteLength(base)) + '"');
    expect(parseFrame(frame).type).toBe("ping");
    expect(() => parseFrame(frame + " ")).toThrow();
  });
  it("splits over 32 KiB at Unicode code-point boundaries", () => {
    const input = "a".repeat(32767) + "中😀文".repeat(6000);
    const chunks = chunkUtf8(input);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(input);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk)).toBeLessThanOrEqual(32768);
      expect(Buffer.from(chunk).toString("utf8")).toBe(chunk);
    }
  });
  it("supports a small byte limit and refuses an indivisible character", () => {
    expect(chunkUtf8("中😀a", 4)).toEqual(["中", "😀", "a"]);
    expect(chunkUtf8("")).toEqual([]);
    expect(() => chunkUtf8("中", 2)).toThrow();
    expect(() => chunkUtf8("a", 0)).toThrow();
  });
});

describe("strict server result and callback whitelist", () => {
  it("accepts the complete result whitelist including nullable fields and accounting", () => {
    const result = {
      ...success, errorCode: null, errorMessage: null, errorFamily: "configuration", retryNotBefore: "2026-10-25T10:30:00+08:00", errorMeta: { detail: true },
      summary: null, resultJson: { ok: true }, sessionId: null, sessionDisplayId: "run", sessionParams: null, clearSession: true, usageComplete: true,
      usage: { inputTokens: 2, outputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0.5 }, usageByModel: [{ model: "fake-model", usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 }],
      usageBasis: "per_run", provider: null, biller: "fake", model: null, billingType: "subscription_included", costUsd: null, costUsdExact: "0.01", costStatus: "estimated",
      pricingContext: { serviceTier: "standard", contextTier: "long" }, pricingProvenance: { source: "operator", version: "v1", evidence: "fixture", inputCentsPerMillion: "1", cachedInputCentsPerMillion: "1", outputCentsPerMillion: "2", cacheWriteCentsPerMillion: "1", serviceTier: "standard", contextTier: "short" },
      cacheAdjustedCostUsd: 0, providerRequestId: null, executionRecovery: { kind: "interrupted", providerStopped: true, sessionPreserved: true, actionOutcomes: "settled" },
    };
    expect(validateResult(result)).toEqual(result);
    expect(validateResult({ ...success, executionRecovery: { kind: "bootstrap", providerWorkStarted: false } }).exitCode).toBe(0);
  });
  it.each([
    { extra: true }, { exitCode: 0.5 }, { signal: 0 }, { timedOut: null },
    { usage: { inputTokens: 1, outputTokens: 2, unknown: true } },
    { usage: { inputTokens: -1, outputTokens: 2 } },
    { usage: { inputTokens: Infinity, outputTokens: 2 } },
    { usageByModel: [{ model: "m", usage: { inputTokens: 1, outputTokens: 2 }, costUsd: 0, extra: true }] },
    { pricingContext: { contextTier: "medium" } }, { pricingContext: { unknown: true } },
    { pricingProvenance: { source: "unknown", extra: true } },
    { executionRecovery: { kind: "bootstrap", providerWorkStarted: true } },
    { executionRecovery: { kind: "interrupted", providerStopped: true, sessionPreserved: true, actionOutcomes: "settled", extra: true } },
    { billingType: "free" }, { costUsd: -1 }, { retryNotBefore: "2026-02-30T12:00:00Z" }, { retryNotBefore: "2026-10-25" }, { errorMeta: [] },
  ])("rejects unknown or invalid result fields: %j", (fields) => {
    expect(() => validateResult({ ...success, ...fields })).toThrow();
  });
  it("requires all three completion fields", () => {
    for (const field of ["exitCode", "signal", "timedOut"]) {
      const value: Record<string, unknown> = { ...success };
      delete value[field];
      expect(() => validateResult(value)).toThrow();
    }
  });
  it("rejects non-record objects and symbol record keys as the server does", () => {
    expect(() => validateResult({ ...success, errorMeta: new Date() })).toThrow();
    expect(() => validateResult({ ...success, sessionParams: { [Symbol("key")]: "value" } })).toThrow();
  });
  it("validates meta, events and usage checkpoints against their own strict schemas", () => {
    const meta = { adapterType: "echo", command: "echo", cwd: "test", commandArgs: ["a"], commandNotes: ["note"], env: { A: "B" }, prompt: "test", promptMetrics: { bytes: 1 }, context: { future: true } };
    expect(validateMeta(meta)).toEqual(meta);
    expect(validateEvent({ eventType: "test", stream: "system", level: "warn", color: "blue", message: "测试", payload: {} }).eventType).toBe("test");
    expect(validateUsage({ complete: true, attemptId: "attempt", usageBasis: "session_cumulative", costStatus: "unpriced" }).complete).toBe(true);
    expect(() => validateMeta({ ...meta, unknown: true })).toThrow();
    expect(() => validateMeta({ ...meta, promptMetrics: { tokens: -1 } })).toThrow();
    expect(() => validateMeta({ ...meta, env: { A: 2 } })).toThrow();
    expect(() => validateEvent({ eventType: "test", stream: "other" })).toThrow();
    expect(() => validateEvent({ eventType: "test", unknown: true })).toThrow();
    expect(() => validateUsage({ complete: true, unknown: true })).toThrow();
    expect(() => validateUsage({ usage: { inputTokens: 1, outputTokens: 2 } })).toThrow();
  });
});

type RequestRecord = { method: string; url: string; headers: IncomingMessage["headers"]; body: Record<string, unknown> };
const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); });

async function fixture(respond: (request: RequestRecord, response: ServerResponse) => void) {
  const requests: RequestRecord[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk.toString();
    const request = { method: req.method!, url: req.url!, headers: req.headers, body: JSON.parse(body) };
    requests.push(request);
    respond(request, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture address");
  return { requests, serverUrl: `http://127.0.0.1:${address.port}` };
}

function hooks(serverUrl: string, context: Record<string, unknown> = { issueId: "fake-issue/中文" }, controller = new AbortController()) {
  const logs: Array<{ stream: string; text: string }> = [];
  const job: JobStart = { v: 1, type: "job.start", jobId: "fake-run", companyId: "fake-company", agent: { id: "fake-agent", name: "测试" }, authToken: "fake-run-token-never-real", context, config: {}, runtime: {}, runtimeTools: null, handoffMarkdown: "", codeSyncDir: "" };
  const value: ExecutorHooks = { job, serverUrl, signal: controller.signal, event() {}, log(stream, text) { logs.push({ stream, text }); } };
  return { value, logs, controller };
}

describe("echo executor local HTTP writeback", () => {
  it("posts a version/hostname comment then marks the encoded issue done with run authentication", async () => {
    const local = await fixture((_request, res) => { res.writeHead(200); res.end("{}"); });
    const input = hooks(local.serverUrl);
    expect(await echoExecutor.execute(input.value)).toMatchObject({ ...success, summary: "echo 执行器完成" });
    expect(local.requests.map((r) => r.method)).toEqual(["POST", "PATCH"]);
    expect(local.requests[0].url).toBe("/api/issues/fake-issue%2F%E4%B8%AD%E6%96%87/comments");
    expect(local.requests[1].url).toBe("/api/issues/fake-issue%2F%E4%B8%AD%E6%96%87");
    expect(local.requests[0].body.body).toContain(AGENT_VERSION);
    expect(local.requests[0].body.body).toContain(hostname());
    expect(local.requests[1].body).toMatchObject({ status: "done", comment: expect.any(String) });
    for (const request of local.requests) {
      expect(request.headers.authorization).toBe("Bearer fake-run-token-never-real");
      expect(request.headers["x-paperclip-run-id"]).toBe("fake-run");
      expect(request.headers["content-type"]).toContain("application/json");
      expect(JSON.stringify(request.body)).not.toContain(input.value.job.authToken);
    }
    expect(input.logs[0]).toEqual({ stream: "stdout", text: "成员代理收到任务 fake-run\n" });
    expect(JSON.stringify(input.logs)).not.toContain(input.value.job.authToken);
  });
  it("uses taskId when issueId is absent", async () => {
    const local = await fixture((_request, res) => { res.writeHead(200); res.end("{}"); });
    const input = hooks(local.serverUrl, { taskId: "fake-task" });
    expect((await echoExecutor.execute(input.value)).exitCode).toBe(0);
    expect(local.requests[0].url).toBe("/api/issues/fake-task/comments");
  });
  it("only logs for a task without an issue", async () => {
    const input = hooks("http://127.0.0.1:1", {});
    expect((await echoExecutor.execute(input.value)).exitCode).toBe(0);
    expect(input.logs).toHaveLength(1);
  });
  it.each(["POST", "PATCH"])("returns safe HTTP errors when %s fails without leaking response bodies", async (method) => {
    const local = await fixture((request, res) => { res.writeHead(request.method === method ? 403 : 200); res.end("fake-run-token-never-real sensitive response body"); });
    const input = hooks(local.serverUrl);
    const result = await echoExecutor.execute(input.value);
    expect(result).toMatchObject({ exitCode: 1, errorCode: "member_agent_echo_writeback_failed", errorMessage: expect.stringContaining("403") });
    expect(local.requests).toHaveLength(method === "POST" ? 1 : 2);
    expect(JSON.stringify({ result, logs: input.logs })).not.toMatch(/fake-run-token-never-real|sensitive response body/);
    expect(input.logs.some((line) => line.stream === "stderr")).toBe(true);
  });
  it("returns a safe failure when the network request fails", async () => {
    const input = hooks("http://127.0.0.1:1");
    expect(await echoExecutor.execute(input.value)).toMatchObject({ exitCode: 1, errorCode: "member_agent_echo_writeback_failed" });
  });
  it("does no HTTP work after cancellation before the first step", async () => {
    const local = await fixture((_request, res) => res.end("{}"));
    const input = hooks(local.serverUrl);
    input.controller.abort("fake-run-token-never-real");
    expect(await echoExecutor.execute(input.value)).toMatchObject({ exitCode: 1, errorCode: "cancelled" });
    expect(local.requests).toHaveLength(0);
    expect(JSON.stringify(input.logs)).not.toContain("fake-run-token-never-real");
  });
  it("checks cancellation between comment and status PATCH", async () => {
    const controller = new AbortController();
    const local = await fixture((_request, res) => { controller.abort(); res.end("{}"); });
    const input = hooks(local.serverUrl, { issueId: "fake-issue" }, controller);
    expect(await echoExecutor.execute(input.value)).toMatchObject({ exitCode: 1, errorCode: "cancelled" });
    expect(local.requests).toHaveLength(1);
  });
  it("aborts an in-flight HTTP writeback", async () => {
    const controller = new AbortController();
    const local = await fixture(() => controller.abort());
    const input = hooks(local.serverUrl, { issueId: "fake-issue" }, controller);
    expect(await echoExecutor.execute(input.value)).toMatchObject({ exitCode: 1, errorCode: "cancelled" });
    expect(local.requests).toHaveLength(1);
  });
});
