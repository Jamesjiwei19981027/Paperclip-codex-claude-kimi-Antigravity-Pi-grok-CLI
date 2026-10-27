import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentApiKeys, companies, createDb, heartbeatRunEvents, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";

const require = createRequire(import.meta.url);
const { WebSocket } = require("ws");

// Test-only fake agent. No CLI, account, production URL, or business task.
class FakeMemberAgent {
  socket: any;
  frames: Array<Record<string, any>> = [];
  constructor(url: string, key?: string) {
    this.socket = new WebSocket(url, { headers: key ? { Authorization: `Bearer ${key}` } : {} });
    this.socket.on("error", () => {});
    this.socket.on("message", (bytes: Buffer) => this.frames.push(JSON.parse(bytes.toString())));
  }
  send(type: string, fields: Record<string, unknown> = {}) {
    this.socket.send(JSON.stringify({ v: 1, type, ...fields }));
  }
  async wait(type: string, timeoutMs = 3000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const frame = this.frames.find(frame => frame.type === type);
      if (frame) return frame;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error(`Fake agent did not receive ${type}`);
  }
  async hello() {
    await once(this.socket, "open");
    this.send("hello", { agentVersion: "test", codexVersion: "0.160.0", platform: "win32", hostname: "fixture" });
    return this.wait("hello.ack");
  }
  close() { this.socket.terminate(); }
}

describe("member_agent phase 1", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let server: Server;
  let transport: any;
  let api: any;
  let heartbeat: ReturnType<typeof import("../../services/heartbeat.js").heartbeatService>;
  let url: string;
  const peers: FakeMemberAgent[] = [];
  const fixtures: Array<{ agentId: string; companyId: string; key: string }> = [];

  beforeAll(async () => {
    api = await import("../../realtime/member-agent-ws.js").catch(() => null);
    if (api) {
      vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "member-phase1-isolated-test-signing-secret");
      vi.stubEnv("PAPERCLIP_AGENT_JWT_TTL_SECONDS", "172800");
      await boot();
      heartbeat = (await import("../../services/heartbeat.js")).heartbeatService(db);
    }
  }, 120000);
  it("registers the transport module required by the nine acceptance cases", () => {
    expect(api, "member-agent WebSocket service is not implemented").not.toBeNull();
  });

  async function boot() {
    expect(api).not.toBeNull();
    if (url) return;
    database = await startEmbeddedPostgresTestDatabase("member-agent-phase1-");
    db = createDb(database.connectionString);
    server = createServer();
    transport = api.setupMemberAgentWebSocketServer(server, db, { deploymentMode: "authenticated" });
    // Must coexist with the existing catch-all live-events upgrade handler.
    const { setupLiveEventsWebSocketServer } = await import("../../realtime/live-events-ws.js");
    setupLiveEventsWebSocketServer(server, db, { deploymentMode: "authenticated" });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    url = `ws://127.0.0.1:${(server.address() as any).port}/api/member-agent/v1/connect`;
  }
  async function fixture(adapterType = "member_agent", revoked = false, status = "idle", existingCompanyId?: string) {
    await boot();
    const companyId = existingCompanyId ?? randomUUID(), agentId = randomUUID(), key = `fixture-key-${randomUUID()}`;
    if (!existingCompanyId) await db.insert(companies).values({ id: companyId, name: "Member test", issuePrefix: `M${companyId.slice(0, 6)}`, defaultResponsibleUserId: "fixture-user", requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Fixture member", adapterType, status });
    await db.insert(agentApiKeys).values({ companyId, agentId, name: "test", keyHash: createHash("sha256").update(key).digest("hex"), revokedAt: revoked ? new Date() : null });
    const result = { companyId, agentId, key };
    fixtures.push(result);
    return result;
  }
  function peer(key?: string, suffix = "") {
    const agent = new FakeMemberAgent(url + suffix, key);
    peers.push(agent);
    return agent;
  }
  function context(f: Awaited<ReturnType<typeof fixture>>, overrides: Partial<AdapterExecutionContext> = {}) {
    return {
      runId: randomUUID(), agent: { id: f.agentId, companyId: f.companyId, name: "Member", adapterType: "member_agent", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {}, context: { issueId: randomUUID() }, authToken: `fixture-run-${randomUUID()}`,
      getFreshSessionHandoff: async () => "Fixture task history", onLog: vi.fn(async () => {}),
      onMeta: vi.fn(async () => {}), onEvent: vi.fn(async () => {}), onUsage: vi.fn(async () => {}),
      onDispatch: vi.fn(), onCancellationReady: vi.fn(async () => {}), ...overrides,
    } satisfies AdapterExecutionContext;
  }
  async function execute(ctx: AdapterExecutionContext) { return (await import("./execute.js")).execute(ctx); }
  afterEach(async () => {
    vi.useRealTimers();
    for (const p of peers.splice(0)) p.close();
    await new Promise(resolve => setTimeout(resolve, 10));
  });
  afterAll(async () => {
    await heartbeat?.drainActiveRunExecutions();
    await transport?.close();
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    await db?.$client.end();
    await database?.cleanup();
    vi.unstubAllEnvs();
  });

  it.each(["missing", "wrong", "revoked", "other_adapter", "paused", "terminated", "query_only"])("1 rejects invalid authentication: %s", async kind => {
    const f = await fixture(kind === "other_adapter" ? "codex_local" : "member_agent", kind === "revoked", ["paused", "terminated"].includes(kind) ? kind : "idle");
    const p = peer(kind === "missing" || kind === "query_only" ? undefined : kind === "wrong" ? "invalid-fixture-key" : f.key, kind === "query_only" ? `?token=${encodeURIComponent(f.key)}` : "");
    const closed = new Promise(resolve => p.socket.once("close", resolve));
    p.socket.on("open", () => p.send("hello", { agentVersion: "test", codexVersion: "0.160.0", platform: "win32", hostname: "fixture" }));
    await closed;
    expect(p.frames.some(frame => frame.type === "hello.ack")).toBe(false);
  });
  it("2 refuses a second connection without evicting the first", async () => {
    const f = await fixture(), first = peer(f.key);
    expect(await first.hello()).toMatchObject({ pinnedCodexVersion: "0.160.0" });
    const second = peer(f.key);
    await once(second.socket, "open");
    expect(await second.wait("hello.reject")).toMatchObject({ code: "already_connected" });
    expect(first.socket.readyState).toBe(WebSocket.OPEN);
  });
  it("does not rate-limit quick reconnects after already_connected refusals", async () => {
    const f = await fixture(), first = peer(f.key); await first.hello();
    for (let i = 0; i < 5; i++) {
      const duplicate = peer(f.key);
      expect(await duplicate.wait("hello.reject")).toMatchObject({ code: "already_connected" });
    }
    first.close();
    const reconnect = peer(f.key);
    expect(await reconnect.hello()).toMatchObject({ type: "hello.ack" });
  });
  it("3 fails an offline dispatch immediately with a visible error", async () => {
    const f = await fixture(), ctx = context(f);
    expect(await execute(ctx)).toMatchObject({ exitCode: 1, errorCode: "member_agent_offline" });
    expect(ctx.onLog).toHaveBeenCalledWith("stderr", expect.stringContaining("不在线"));
    expect(ctx.onDispatch).not.toHaveBeenCalled();
  });
  it("4 relays job, ordered logs, events, usage, and the first result", async () => {
    const f = await fixture(), p = peer(f.key); await p.hello();
    const ctx = context(f, { runtimeTools: { version: 1, guidance: "Use connection REST", mcpEndpoint: "https://fixture.invalid/mcp", rest: { connectionsSearch: "https://fixture.invalid/search", connectionRequest: "https://fixture.invalid/request" }, bearerToken: "fixture-tool-secret", expiresAt: "2026-10-25T23:00:00Z", tools: ["connections_search", "connection_request"] }, config: { maxRunSec: 90, model: "must-not-forward", command: "must-not-forward" } });
    const pending = execute(ctx), job = await p.wait("job.start");
    expect(job.config).toEqual({ maxRunSec: 90 });
    expect(job.runtimeTools.bearerToken).toBe("fixture-tool-secret");
    expect(job.handoffMarkdown).toBe("Fixture task history");
    p.send("job.accepted", { jobId: job.jobId });
    p.send("job.log", { jobId: job.jobId, seq: 1, stream: "stdout", chunk: "first\n" });
    p.send("job.log", { jobId: job.jobId, seq: 1, stream: "stdout", chunk: "duplicate" });
    p.send("job.log", { jobId: job.jobId, seq: 2, stream: "stderr", chunk: "second\n" });
    p.send("job.event", { jobId: job.jobId, seq: 1, event: { eventType: "fixture.progress", message: "working" } });
    p.send("job.usage", { jobId: job.jobId, usage: { complete: true, usage: { inputTokens: 12, outputTokens: 3 } } });
    p.send("job.result", { jobId: job.jobId, exitCode: 0, signal: null, timedOut: false, summary: "completed", usage: { inputTokens: 12, outputTokens: 3 }, usageComplete: true });
    p.send("job.result", { jobId: job.jobId, exitCode: 1, signal: null, timedOut: false });
    expect(await pending).toMatchObject({ exitCode: 0, summary: "completed", usage: { inputTokens: 12, outputTokens: 3 } });
    expect(ctx.onLog).toHaveBeenCalledWith("stdout", "first\n");
    expect(ctx.onLog).toHaveBeenCalledWith("stderr", "second\n");
    expect(JSON.stringify((ctx.onLog as any).mock.calls)).not.toContain("duplicate");
    expect(ctx.onUsage).toHaveBeenCalledWith(expect.objectContaining({ complete: true }));
    expect(ctx.onEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: "fixture.progress" }));
    expect(ctx.onDispatch).toHaveBeenCalledOnce(); expect(ctx.onCancellationReady).toHaveBeenCalledOnce();
  });
  it("routes two members' simultaneous jobs, logs, and results only to their own run", async () => {
    const first = await fixture();
    const second = await fixture("member_agent", false, "idle", first.companyId);
    const firstPeer = peer(first.key), secondPeer = peer(second.key);
    await Promise.all([firstPeer.hello(), secondPeer.hello()]);
    const firstProjectId = `project-${randomUUID()}`, secondProjectId = `project-${randomUUID()}`;
    const firstContext = context(first, { context: { issueId: randomUUID(), projectId: firstProjectId } });
    const secondContext = context(second, { context: { issueId: randomUUID(), projectId: secondProjectId } });

    const firstPending = execute(firstContext), secondPending = execute(secondContext);
    const [firstJob, secondJob] = await Promise.all([firstPeer.wait("job.start"), secondPeer.wait("job.start")]);
    expect(firstJob.jobId).toBe(firstContext.runId);
    expect(secondJob.jobId).toBe(secondContext.runId);
    expect(firstJob.jobId).not.toBe(secondJob.jobId);
    expect(firstJob.context.projectId).toBe(firstProjectId);
    expect(secondJob.context.projectId).toBe(secondProjectId);
    expect(firstPeer.frames.filter(frame => frame.type === "job.start").map(frame => frame.jobId)).toEqual([firstJob.jobId]);
    expect(secondPeer.frames.filter(frame => frame.type === "job.start").map(frame => frame.jobId)).toEqual([secondJob.jobId]);

    firstPeer.send("job.accepted", { jobId: firstJob.jobId });
    secondPeer.send("job.accepted", { jobId: secondJob.jobId });
    // A valid but foreign run ID on either socket must not select another agent's callbacks.
    firstPeer.send("job.log", { jobId: secondJob.jobId, seq: 1, stream: "stdout", chunk: "foreign-to-first\n" });
    firstPeer.send("job.result", { jobId: secondJob.jobId, exitCode: 9, signal: null, timedOut: false, summary: "foreign-result" });
    firstPeer.send("job.log", { jobId: firstJob.jobId, seq: 1, stream: "stdout", chunk: "first-member-only\n" });
    secondPeer.send("job.log", { jobId: secondJob.jobId, seq: 1, stream: "stdout", chunk: "second-member-only\n" });
    secondPeer.send("job.result", { jobId: secondJob.jobId, exitCode: 0, signal: null, timedOut: false, summary: "second-result" });
    firstPeer.send("job.result", { jobId: firstJob.jobId, exitCode: 0, signal: null, timedOut: false, summary: "first-result" });

    const [firstResult, secondResult] = await Promise.all([firstPending, secondPending]);
    expect(firstResult).toMatchObject({ exitCode: 0, summary: "first-result" });
    expect(secondResult).toMatchObject({ exitCode: 0, summary: "second-result" });
    expect((firstContext.onLog as ReturnType<typeof vi.fn>).mock.calls).toEqual([["stdout", "first-member-only\n"]]);
    expect((secondContext.onLog as ReturnType<typeof vi.fn>).mock.calls).toEqual([["stdout", "second-member-only\n"]]);
  });
  it("4 persists a real heartbeat run, visible logs, usage and result without credentials", async () => {
    const f = await fixture(), p = peer(f.key); await p.hello();
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId: f.companyId, title: "Isolated member acceptance", status: "in_progress", assigneeAgentId: f.agentId, responsibleUserId: "fixture-user" });
    await db.insert(issueComments).values({ companyId: f.companyId, issueId, authorUserId: "fixture-user", body: "Read fixture context and report synthetic success; no business tasks." });
    const queued = await heartbeat.invoke(f.agentId, "on_demand", { issueId, taskId: issueId }, "manual");
    expect(queued).not.toBeNull();
    const job = await p.wait("job.start", 10000);
    expect(job.jobId).toBe(queued!.id);
    expect(job.handoffMarkdown).toContain("Read fixture context");
    expect(job.authToken).toBeTruthy();
    p.send("job.accepted", { jobId: job.jobId });
    p.send("job.log", { jobId: job.jobId, seq: 1, stream: "stdout", chunk: "board-visible-first\n" });
    p.send("job.log", { jobId: job.jobId, seq: 2, stream: "stderr", chunk: `board-visible-second ${job.authToken} ${f.key}\n` });
    p.send("job.usage", { jobId: job.jobId, usage: { complete: true, usageBasis: "per_run", provider: "openai", model: "fixture-model", billingType: "subscription_included", usage: { inputTokens: 12, outputTokens: 3 }, costUsd: 0 } });
    // This fixture checks run persistence, not task auto-continuation.
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
    p.send("job.result", { jobId: job.jobId, exitCode: 0, signal: null, timedOut: false, provider: "openai", model: "fixture-model", billingType: "subscription_included", usageBasis: "per_run", summary: "Fixture completed", resultJson: { proof: "member-websocket", echo: job.authToken }, usage: { inputTokens: 12, outputTokens: 3 }, costUsd: 0, usageComplete: true });
    let finished = await heartbeat.getRun(job.jobId);
    const deadline = Date.now() + 10000;
    while (finished && ["queued", "running"].includes(finished.status) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
      finished = await heartbeat.getRun(job.jobId);
    }
    expect(finished).toMatchObject({ status: "succeeded", exitCode: 0, usageJson: { inputTokens: 12, outputTokens: 3 }, resultJson: { proof: "member-websocket" } });
    const log = await heartbeat.readLog(job.jobId, { offset: 0, limitBytes: 1000000 });
    expect(log.content).toContain("board-visible-first");
    expect(log.content).toContain("board-visible-second");
    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, job.jobId));
    const persisted = JSON.stringify({ finished, events, log });
    expect(persisted).not.toContain(job.authToken);
    expect(persisted).not.toContain(f.key);
  }, 20000);
  it("5 fails at the five-second acceptance deadline", async () => {
    const f = await fixture(), p = peer(f.key); await p.hello();
    const started = Date.now();
    const pending = execute(context(f)); await p.wait("job.start");
    let settled = false; void pending.then(() => { settled = true; }); await Promise.resolve(); expect(settled).toBe(false);
    expect(await pending).toMatchObject({ errorCode: "member_agent_not_accepted" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(4990);
    expect(Date.now() - started).toBeLessThan(6500);
  });
  it("6 fails a silent connection within 45 seconds", async () => {
    const f = await fixture(), p = peer(f.key); await p.hello();
    const pending = execute(context(f)), job = await p.wait("job.start"); p.send("job.accepted", { jobId: job.jobId });
    await new Promise(resolve => setTimeout(resolve, 10));
    // Invoke the same sweep used by the server interval; no 45s wall-clock sleep.
    transport.sweep(Date.now() + 45000);
    expect(await pending).toMatchObject({ errorCode: "member_agent_disconnected" });
  });
  it("7 sends job.cancel and settles the operator abort", async () => {
    const f = await fixture(), p = peer(f.key); await p.hello();
    const controller = new AbortController(), ctx = context(f, { signal: controller.signal });
    const pending = execute(ctx), job = await p.wait("job.start"); p.send("job.accepted", { jobId: job.jobId });
    controller.abort(); expect(await p.wait("job.cancel")).toMatchObject({ jobId: job.jobId });
    p.send("job.result", { jobId: job.jobId, exitCode: null, signal: null, timedOut: false, errorCode: "cancelled", errorMessage: "cancelled" });
    expect(await pending).toMatchObject({ errorCode: "cancelled" });
  });
  it("8 never delivers another company's job to a valid connected member", async () => {
    const a = await fixture(), b = await fixture(), p = peer(a.key); await p.hello();
    expect(await execute(context(a, { agent: { id: a.agentId, companyId: b.companyId, name: "forged", adapterType: "member_agent", adapterConfig: {} } }))).toMatchObject({ errorCode: "member_agent_offline" });
    expect(p.frames.some(frame => frame.type === "job.start")).toBe(false);
  });
  it("9 redacts full and split run/tool/key secrets from logs and structured results", async () => {
    const f = await fixture(), p = peer(f.key); await p.hello();
    const ctx = context(f, { runtimeTools: { version: 1, guidance: "fixture", mcpEndpoint: "https://fixture.invalid/mcp", rest: { connectionsSearch: "https://fixture.invalid/search", connectionRequest: "https://fixture.invalid/request" }, bearerToken: "fixture-tool-secret-to-redact", expiresAt: "2026-10-25T23:00:00Z", tools: ["connections_search", "connection_request"] } }), pending = execute(ctx), job = await p.wait("job.start");
    p.send("job.accepted", { jobId: job.jobId });
    const secret = ctx.authToken!;
    p.send("job.log", { jobId: job.jobId, seq: 1, stream: "stdout", chunk: secret.slice(0, 12) });
    p.send("job.log", { jobId: job.jobId, seq: 2, stream: "stdout", chunk: secret.slice(12) + f.key });
    p.send("job.meta", { jobId: job.jobId, meta: { adapterType: "member_agent", command: secret, env: { SECRET: secret } } });
    p.send("job.result", { jobId: job.jobId, exitCode: 1, signal: null, timedOut: false, errorCode: "fixture_failure", errorMessage: secret + ctx.runtimeTools!.bearerToken, resultJson: { echo: secret, [ctx.runtimeTools!.bearerToken]: f.key } });
    const result = await pending, output = JSON.stringify({ result, logs: (ctx.onLog as any).mock.calls, meta: (ctx.onMeta as any).mock.calls });
    expect(output).not.toContain(secret); expect(output).not.toContain(f.key);
    expect(output).not.toContain(ctx.runtimeTools!.bearerToken);
    expect((ctx.onLog as any).mock.calls.map((c: any[]) => c[1]).join("")).not.toContain(secret);
  });
  it.each(["token", "config"])("fails explicitly before dispatch for missing/invalid %s", async kind => {
    const f = await fixture(), p = peer(f.key); await p.hello();
    const ctx = context(f, kind === "token" ? { authToken: "" } : { config: { maxRunSec: 14401 } });
    const result = await execute(ctx);
    expect(result).toMatchObject({ exitCode: 1, errorCode: { token: "member_agent_no_token", config: "member_agent_invalid_config" }[kind] });
    expect(ctx.onLog).toHaveBeenCalledWith("stderr", expect.any(String));
    expect(p.frames.some(frame => frame.type === "job.start")).toBe(false);
    expect(api.memberAgentConnections.get(f.companyId, f.agentId).currentJobId).toBeNull();
  });
  it("dispatches without a handoff function or context summary", async () => {
    const f = await fixture(), p = peer(f.key); await p.hello();
    const ctx = context(f, { getFreshSessionHandoff: undefined, context: { issueId: randomUUID() } });
    const pending = execute(ctx), job = await p.wait("job.start");
    expect(job.handoffMarkdown).toBe("");
    p.send("job.accepted", { jobId: job.jobId });
    p.send("job.result", { jobId: job.jobId, exitCode: 0, signal: null, timedOut: false });
    expect(await pending).toMatchObject({ exitCode: 0 });
  });
  it("dispatches with a null history handoff", async () => {
    const f = await fixture(), p = peer(f.key); await p.hello();
    const ctx = context(f, { getFreshSessionHandoff: async () => null });
    const pending = execute(ctx), job = await p.wait("job.start");
    expect(job.handoffMarkdown).toBe("");
    p.send("job.accepted", { jobId: job.jobId });
    p.send("job.result", { jobId: job.jobId, exitCode: 0, signal: null, timedOut: false });
    expect(await pending).toMatchObject({ exitCode: 0 });
  });
  it("fails with a history generation error before dispatch when handoff throws", async () => {
    const f = await fixture(), p = peer(f.key); await p.hello();
    const ctx = context(f, { getFreshSessionHandoff: async () => { throw new Error("synthetic history failure"); } });
    expect(await execute(ctx)).toMatchObject({ exitCode: 1, errorCode: "member_agent_dispatch_failed" });
    expect(ctx.onLog).toHaveBeenCalledWith("stderr", expect.stringContaining("生成历史摘要出错"));
    expect(p.frames.some(frame => frame.type === "job.start")).toBe(false);
  });
  it("keeps the newest complete UTF-8 history bytes under the handoff limit", async () => {
    const f = await fixture(), p = peer(f.key); await p.hello();
    const history = `${"早期记录。".repeat(5000)}\n结尾最新内容：重要决定已确认。`;
    const pending = execute(context(f, { getFreshSessionHandoff: async () => history }));
    const job = await p.wait("job.start");
    expect(Buffer.byteLength(job.handoffMarkdown, "utf8")).toBeLessThanOrEqual(24000);
    expect(job.handoffMarkdown.startsWith("[更早的历史已省略]\n")).toBe(true);
    expect(job.handoffMarkdown.endsWith("结尾最新内容：重要决定已确认。")).toBe(true);
    p.send("job.accepted", { jobId: job.jobId });
    p.send("job.result", { jobId: job.jobId, exitCode: 0, signal: null, timedOut: false });
    expect(await pending).toMatchObject({ exitCode: 0 });
  });
  it("reserves one job atomically and releases it after completion", async () => {
    const f = await fixture(), p = peer(f.key); await p.hello();
    const first = execute(context(f)), job = await p.wait("job.start");
    const before = Date.now();
    const busy = await execute(context(f));
    expect(busy).toMatchObject({ errorCode: "member_agent_busy", errorFamily: "transient_upstream", executionRecovery: { kind: "bootstrap", providerWorkStarted: false } });
    expect(new Date(busy.retryNotBefore!).getTime()).toBeGreaterThanOrEqual(before + 30000);
    expect(p.frames.filter(frame => frame.type === "job.start")).toHaveLength(1);
    p.send("job.accepted", { jobId: job.jobId });
    p.send("job.result", { jobId: job.jobId, exitCode: 0, signal: null, timedOut: false });
    expect(await first).toMatchObject({ exitCode: 0 });
    expect(api.memberAgentConnections.get(f.companyId, f.agentId).currentJobId).toBeNull();
  });

  it("treats a valid pre-acceptance member busy rejection as retryable, not a protocol failure", async () => {
    const f = await fixture(), p = peer(f.key); await p.hello();
    const pending = execute(context(f)), job = await p.wait("job.start");
    p.send("job.result", { jobId: job.jobId, exitCode: 1, signal: null, timedOut: false, errorCode: "member_agent_busy", errorMessage: "成员代理正在执行其他任务" });
    const result = await pending;
    expect(result).toMatchObject({ exitCode: 1, errorCode: "member_agent_busy", errorFamily: "transient_upstream", executionRecovery: { kind: "bootstrap", providerWorkStarted: false } });
    expect(result.retryNotBefore).toEqual(expect.any(String));
    expect(api.memberAgentConnections.get(f.companyId, f.agentId).currentJobId).toBeNull();
  });

  it("does not authorize automatic replay for a busy error after the member accepted work", async () => {
    const f = await fixture(), p = peer(f.key); await p.hello();
    const pending = execute(context(f)), job = await p.wait("job.start");
    p.send("job.accepted", { jobId: job.jobId });
    p.send("job.result", { jobId: job.jobId, exitCode: 1, signal: null, timedOut: false, errorCode: "member_agent_busy" });
    const result = await pending;
    expect(result).not.toHaveProperty("executionRecovery");
    expect(result).not.toHaveProperty("errorFamily");
  });

  it.each(["server", "member"])("automatically schedules and redispatches an unstarted %s busy job through the heartbeat scheduler", async (source) => {
    const f = await fixture(), p = peer(f.key); await p.hello();
    await db.update(agents).set({ runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } }).where(eq(agents.id, f.agentId));
    const held = source === "server" ? execute(context(f)) : null;
    const heldJob = held ? await p.wait("job.start") : null;
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId: f.companyId, title: "Busy retry integration", status: "in_progress", assigneeAgentId: f.agentId, responsibleUserId: "fixture-user" });
    const queued = await heartbeat.invoke(f.agentId, "on_demand", { issueId, taskId: issueId }, "manual");
    expect(queued).not.toBeNull();
    if (source === "member") {
      await expect.poll(() => p.frames.find(frame => frame.type === "job.start" && frame.jobId === queued!.id), { timeout: 10000 }).toBeDefined();
      p.send("job.result", { jobId: queued!.id, exitCode: 1, signal: null, timedOut: false, errorCode: "member_agent_busy" });
    }
    await expect.poll(async () => (await heartbeat.getRun(queued!.id))?.status, { timeout: 10000 }).toBe("failed");
    const failed = await heartbeat.getRun(queued!.id);
    expect(failed?.resultJson).toMatchObject({ errorFamily: "transient_upstream", executionRecovery: { kind: "bootstrap", providerWorkStarted: false } });
    let retry: typeof heartbeatRuns.$inferSelect | undefined;
    await expect.poll(async () => {
      [retry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, queued!.id));
      return retry?.status;
    }, { timeout: 10000 }).toBe("scheduled_retry");
    expect(retry).toMatchObject({ issueId, scheduledRetryReason: "transient_failure", scheduledRetryAttempt: 1 });
    expect(retry!.scheduledRetryAt!.getTime()).toBeGreaterThanOrEqual(new Date(String(failed!.resultJson!.retryNotBefore)).getTime());
    if (heldJob) {
      p.send("job.accepted", { jobId: heldJob.jobId });
      p.send("job.result", { jobId: heldJob.jobId, exitCode: 0, signal: null, timedOut: false });
      await held;
    }
    await expect.poll(() => api.memberAgentConnections.get(f.companyId, f.agentId)?.currentJobId, { timeout: 10000 }).toBeNull();
    // Finish the old run first so its cleanup cannot incidentally dispatch the retry.
    await heartbeat.drainActiveRunExecutions();
    // Mirror the server's scheduled sweep: promote due retries, then start queued runs.
    const promotion = await heartbeat.promoteDueScheduledRetries(retry!.scheduledRetryAt!);
    expect(promotion.runIds).toContain(retry!.id);
    expect((await heartbeat.getRun(retry!.id))?.status).toBe("queued");
    await heartbeat.resumeQueuedRuns();
    await expect.poll(() => p.frames.find(frame => frame.type === "job.start" && frame.jobId === retry!.id), { timeout: 10000 }).toBeDefined();
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
    p.send("job.accepted", { jobId: retry!.id });
    p.send("job.result", { jobId: retry!.id, exitCode: 0, signal: null, timedOut: false, summary: "Retried work completed" });
    await expect.poll(async () => (await heartbeat.getRun(retry!.id))?.status, { timeout: 10000 }).toBe("succeeded");
  }, 30000);
  it.each(["version", "binary", "oversize", "result"])("fails safely for invalid %s frames", async kind => {
    const f = await fixture(), p = peer(f.key); await p.hello();
    const pending = execute(context(f)), job = await p.wait("job.start");
    p.send("job.accepted", { jobId: job.jobId });
    if (kind === "version") p.send("heartbeat", { v: 2 });
    if (kind === "binary") p.socket.send(Buffer.from("invalid binary"));
    if (kind === "oversize") p.send("heartbeat", { payload: "x".repeat(256 * 1024) });
    if (kind === "result") p.send("job.result", { jobId: job.jobId, exitCode: 0, signal: null, timedOut: false, processPid: 12345 });
    expect(await pending).toMatchObject({ exitCode: 1, errorCode: kind === "oversize" ? "member_agent_disconnected" : "member_agent_protocol_error" });
  });
  it("ignores unknown types and foreign job IDs without completing another job", async () => {
    const f = await fixture(), p = peer(f.key); await p.hello();
    const ctx = context(f), pending = execute(ctx), job = await p.wait("job.start");
    p.send("unknown-fixture-type");
    p.send("job.result", { jobId: randomUUID(), exitCode: 1, signal: null, timedOut: false });
    p.send("job.accepted", { jobId: job.jobId });
    p.send("job.result", { jobId: job.jobId, exitCode: 0, signal: null, timedOut: false });
    expect(await pending).toMatchObject({ exitCode: 0 });
  });
  it("enforces total runtime even when the member reports success after cancellation", async () => {
    const f = await fixture(), p = peer(f.key); await p.hello();
    const ctx = context(f, { config: { maxRunSec: 1 } }), pending = execute(ctx), job = await p.wait("job.start");
    p.send("job.accepted", { jobId: job.jobId });
    expect(await p.wait("job.cancel")).toMatchObject({ graceSec: 20 });
    p.send("job.result", { jobId: job.jobId, exitCode: 0, signal: null, timedOut: false });
    expect(await pending).toMatchObject({ timedOut: true, errorCode: "member_agent_timeout", exitCode: 1 });
  });
  it("finishes cancellation after graceSec plus ten seconds without a result", async () => {
    const f = await fixture(), p = peer(f.key); await p.hello();
    const controller = new AbortController(), ctx = context(f, { signal: controller.signal });
    const pending = execute(ctx), job = await p.wait("job.start");
    p.send("job.accepted", { jobId: job.jobId });
    const cancelledAt = Date.now();
    controller.abort();
    expect(await p.wait("job.cancel")).toMatchObject({ graceSec: 20 });
    expect(await pending).toMatchObject({ errorCode: "cancelled", errorMessage: expect.stringContaining("未确认本机进程已停止") });
    expect(Date.now() - cancelledAt).toBeGreaterThanOrEqual(29990);
    expect(Date.now() - cancelledAt).toBeLessThan(35000);
  }, 40000);
  it.each(["cancellation_ready", "history"])("bounds hung %s preparation without dispatch", async kind => {
    const f = await fixture(), p = peer(f.key); await p.hello();
    const never = () => new Promise<never>(() => {});
    const ctx = context(f, { config: { maxRunSec: 1 }, ...(kind === "history" ? { getFreshSessionHandoff: never } : { onCancellationReady: never }) });
    expect(await execute(ctx)).toMatchObject({ errorCode: "member_agent_timeout", timedOut: true });
    expect(p.frames.some(frame => frame.type === "job.start")).toBe(false);
    expect(api.memberAgentConnections.get(f.companyId, f.agentId).currentJobId).toBeNull();
  });
  it("preserves live-events query-key compatibility and checks company scope", async () => {
    const a = await fixture(), b = await fixture();
    const legacyUrl = new URL(url);
    legacyUrl.pathname = `/api/companies/${a.companyId}/events/ws`;
    legacyUrl.searchParams.set("token", a.key);
    const permitted = new FakeMemberAgent(legacyUrl.toString()); peers.push(permitted);
    await once(permitted.socket, "open");
    expect(permitted.socket.readyState).toBe(WebSocket.OPEN);
    legacyUrl.pathname = `/api/companies/${b.companyId}/events/ws`;
    const denied = new FakeMemberAgent(legacyUrl.toString()); peers.push(denied);
    await new Promise(resolve => denied.socket.once("close", resolve));
    expect(denied.socket.readyState).toBe(WebSocket.CLOSED);
    const keyRows = await db.select().from(agentApiKeys).where(eq(agentApiKeys.agentId, a.agentId));
    expect(keyRows[0].lastUsedAt).not.toBeNull();
  });
  it("rate-limits hello failures across multiple keys of one agent", async () => {
    const f = await fixture("member_agent", false, "paused");
    for (let i = 0; i < 5; i++) {
      const p = peer(f.key);
      await once(p.socket, "open");
      expect(await p.wait("hello.reject")).toMatchObject({ code: "member_agent_not_allowed" });
    }
    const alternateKey = `fixture-alternate-${randomUUID()}`;
    await db.insert(agentApiKeys).values({ companyId: f.companyId, agentId: f.agentId, name: "alternate", keyHash: createHash("sha256").update(alternateKey).digest("hex") });
    const sixth = peer(alternateKey);
    let response = "";
    sixth.socket.on("error", (error: Error) => { response = error.message; });
    await new Promise(resolve => sixth.socket.once("close", resolve));
    expect(response).toContain("429");
  });
  it("warns without concrete member identity and enforces the eight-hour startup TTL", async () => {
    const { testEnvironment } = await import("./test.js");
    const result = await testEnvironment({ companyId: randomUUID(), adapterType: "member_agent", config: {} });
    expect(result).toMatchObject({ status: "pass", checks: [{ code: "member_agent_online_check_deferred", level: "info" }] });
    // The lifecycle verifier rejects any `warn`/`fail` result, which would leave the agent paused forever.
    const { assertHarnessTestPassed } = await import("../../services/agent-harness-verification.js");
    expect(() => assertHarnessTestPassed(result)).not.toThrow();
    expect(() => api.assertMemberAgentJwtTtl({ PAPERCLIP_AGENT_JWT_TTL_SECONDS: "28799" })).toThrow();
    expect(() => api.assertMemberAgentJwtTtl({ PAPERCLIP_AGENT_JWT_TTL_SECONDS: "28800" })).not.toThrow();
    const isolated = createServer();
    const disabled = api.setupMemberAgentWebSocketServer(isolated, db, { deploymentMode: "local_trusted" });
    expect(isolated.listenerCount("upgrade")).toBe(0);
    await disabled.close();
  });
  it("enforces the member WebSocket transport address and forwarding rules", async () => {
    const { isMemberAgentTransportAllowed } = await import("../../realtime/member-agent-ws.js");
    const cases = [
      { name: "public IPv4 cleartext", encrypted: false, remoteAddress: "8.8.8.8", want: false },
      { name: "public IPv6 cleartext", encrypted: false, remoteAddress: "2001:4860:4860::8888", want: false },
      { name: "IPv4 loopback", encrypted: false, remoteAddress: "127.255.0.1", want: true },
      { name: "IPv6 loopback", encrypted: false, remoteAddress: "::1", want: true },
      { name: "10/8", encrypted: false, remoteAddress: "10.4.5.6", want: true },
      { name: "172.16/12 lower bound", encrypted: false, remoteAddress: "172.16.0.1", want: true },
      { name: "172.16/12 upper bound", encrypted: false, remoteAddress: "172.31.255.254", want: true },
      { name: "172.32 outside private range", encrypted: false, remoteAddress: "172.32.0.1", want: false },
      { name: "192.168/16", encrypted: false, remoteAddress: "192.168.40.5", want: true },
      { name: "169.254/16", encrypted: false, remoteAddress: "169.254.10.5", want: true },
      { name: "Tailscale CGNAT lower bound", encrypted: false, remoteAddress: "100.64.0.1", want: true },
      { name: "Tailscale CGNAT upper bound", encrypted: false, remoteAddress: "100.127.255.254", want: true },
      { name: "above Tailscale CGNAT range", encrypted: false, remoteAddress: "100.128.0.1", want: false },
      { name: "below Tailscale CGNAT range", encrypted: false, remoteAddress: "100.63.255.255", want: false },
      { name: "IPv4 mapped private address", encrypted: false, remoteAddress: "::ffff:192.168.1.5", want: true },
      { name: "IPv4 mapped Tailscale CGNAT address", encrypted: false, remoteAddress: "::ffff:100.100.1.1", want: true },
      { name: "IPv4 mapped loopback", encrypted: false, remoteAddress: "::ffff:127.0.0.1", want: true },
      { name: "IPv6 unique-local", encrypted: false, remoteAddress: "fc00::", want: true },
      { name: "Tailscale IPv6 unique-local address", encrypted: false, remoteAddress: "fd7a:115c:a1e0::1", want: true },
      { name: "IPv6 link-local", encrypted: false, remoteAddress: "fe80::1", want: true },
      { name: "missing address", encrypted: false, remoteAddress: undefined, want: false },
      { name: "loopback forwarded HTTP", encrypted: false, remoteAddress: "127.0.0.1", forwardedProto: "http", want: false },
      { name: "Tailscale CGNAT forwarded HTTP", encrypted: false, remoteAddress: "100.64.0.1", forwardedProto: "http", want: false },
      { name: "loopback forwarded HTTPS", encrypted: false, remoteAddress: "127.0.0.1", forwardedProto: "https", want: true },
      { name: "public forwarded HTTPS", encrypted: false, remoteAddress: "8.8.8.8", forwardedProto: "https", want: false },
      { name: "TLS socket", encrypted: true, remoteAddress: "8.8.8.8", want: true },
      { name: "TLS socket forwarded HTTP adds rejection", encrypted: true, remoteAddress: "127.0.0.1", forwardedProto: "http", want: false },
    ];
    for (const testCase of cases) {
      expect(isMemberAgentTransportAllowed(testCase).allowed, testCase.name).toBe(testCase.want);
    }
  });
  it("rejects public cleartext upgrades before authentication or failure limiting", async () => {
    const { setupMemberAgentWebSocketServer } = await import("../../realtime/member-agent-ws.js");
    const select = vi.fn(async () => []);
    const fakeDb = { select } as any;
    const isolatedServer = createServer();
    const service = setupMemberAgentWebSocketServer(isolatedServer, fakeDb, { deploymentMode: "authenticated" });
    const responses: string[] = [];
    for (let i = 0; i < 6; i++) {
      const rawSocket: any = { destroyed: false, writable: true, end: vi.fn((data: string) => responses.push(data)), on: vi.fn() };
      const request: any = { url: "/api/member-agent/v1/connect", headers: { authorization: "Bearer untrusted-fixture" }, socket: { remoteAddress: "8.8.8.8", encrypted: false } };
      isolatedServer.emit("upgrade", request, rawSocket, Buffer.alloc(0));
    }
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(select).not.toHaveBeenCalled();
    expect(responses).toHaveLength(6);
    expect(responses.every(response => response.startsWith("HTTP/1.1 403"))).toBe(true);
    await service.close();
  });
});
