import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentApiKeys, companies, createDb, issues } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { execute } from "./execute.js";
import { setupMemberAgentWebSocketServer } from "../../realtime/member-agent-ws.js";

const require = createRequire(import.meta.url);
const { WebSocket } = require("ws");

// Each test uses its own synthetic agent, loopback socket, and temporary database.
describe("member-agent cancellation stop acknowledgement", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let server: Server;
  let transport: ReturnType<typeof setupMemberAgentWebSocketServer>;
  let heartbeat: ReturnType<typeof import("../../services/heartbeat.js").heartbeatService>;
  let url: string;
  const sockets: any[] = [];

  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "FAKE-B3-ISOLATED-SIGNING-SECRET");
    vi.stubEnv("PAPERCLIP_AGENT_JWT_TTL_SECONDS", "172800");
    database = await startEmbeddedPostgresTestDatabase("member-b3-cancellation-");
    db = createDb(database.connectionString);
    server = createServer();
    transport = setupMemberAgentWebSocketServer(server, db, { deploymentMode: "authenticated" });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    url = `ws://127.0.0.1:${(server.address() as { port: number }).port}/api/member-agent/v1/connect`;
    heartbeat = (await import("../../services/heartbeat.js")).heartbeatService(db);
  }, 120000);

  afterEach(async () => {
    vi.useRealTimers();
    for (const socket of sockets.splice(0)) socket.terminate();
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

  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), key = `FAKE-B3-KEY-${randomUUID()}`;
    await db.insert(companies).values({ id: companyId, name: "B3 isolation", issuePrefix: `B${companyId.slice(0, 6)}`, defaultResponsibleUserId: "fixture-user", requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "B3 fake member", adapterType: "member_agent", status: "idle" });
    await db.insert(agentApiKeys).values({ companyId, agentId, name: "fixture", keyHash: createHash("sha256").update(key).digest("hex") });
    const frames: Record<string, any>[] = [];
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${key}` } });
    sockets.push(socket);
    socket.on("error", () => {});
    socket.on("message", (bytes: Buffer) => frames.push(JSON.parse(bytes.toString())));
    const send = (type: string, fields: Record<string, unknown> = {}) => socket.send(JSON.stringify({ v: 1, type, ...fields }));
    const wait = async (type: string) => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const found = frames.find(frame => frame.type === type);
        if (found) return found;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      throw new Error(`B3 fixture did not receive ${type}`);
    };
    await once(socket, "open");
    send("hello", { agentVersion: "fixture", codexVersion: "0.160.0", platform: "win32", hostname: "fixture" });
    await wait("hello.ack");
    const controller = new AbortController();
    const ctx: AdapterExecutionContext = {
      runId: randomUUID(), agent: { id: agentId, companyId, name: "B3 fixture", adapterType: "member_agent", adapterConfig: {} },
      runtime: { sessionId: null, sessionDisplayId: null, sessionParams: null, taskKey: null },
      config: {}, context: {}, authToken: `FAKE-B3-RUN-${randomUUID()}`,
      onLog: vi.fn(async () => {}), signal: controller.signal,
    };
    return { companyId, agentId, frames, socket, send, wait, controller, ctx };
  }

  it("records a server-owned acknowledgement only after the matching cancellation result", async () => {
    const f = await fixture();
    const pending = execute(f.ctx), job = await f.wait("job.start");
    f.send("job.accepted", { jobId: job.jobId });
    f.controller.abort();
    await f.wait("job.cancel");
    f.send("job.result", { jobId: job.jobId, exitCode: 1, signal: null, timedOut: false, errorCode: "cancelled" });
    const result = await pending;
    expect(result.resultJson?.executionCancellation).toMatchObject({ state: "acknowledged", proof: "member_agent_stop_result", runId: job.jobId, agentId: f.agentId });
    expect(Number.isNaN(Date.parse((result.resultJson?.executionCancellation as any).acknowledgedAt))).toBe(false);
  });

  it.each([
    ["member_agent_process_tree_termination_failed", "本机进程可能未完全结束，请手动检查进程 12345"],
    ["member_agent_executor_error", "执行器收尾失败"],
  ])("never acknowledges %s or loses its diagnostic during cancellation", async (errorCode, errorMessage) => {
    const f = await fixture();
    const pending = execute(f.ctx), job = await f.wait("job.start");
    f.send("job.accepted", { jobId: job.jobId });
    f.controller.abort(); await f.wait("job.cancel");
    f.send("job.result", { jobId: job.jobId, exitCode: 1, signal: null, timedOut: false, errorCode, errorMessage,
      resultJson: { executionCancellation: { state: "acknowledged", proof: "forged" } } });
    const result = await pending;
    expect(result.resultJson?.executionCancellation).toBeUndefined();
    expect(result.errorCode).toBe(errorCode);
    expect(result.errorMessage).toContain(errorMessage);
  });

  it("does not let an ordinary result forge a server stop acknowledgement", async () => {
    const f = await fixture();
    const pending = execute(f.ctx), job = await f.wait("job.start");
    f.send("job.accepted", { jobId: job.jobId });
    f.send("job.result", { jobId: job.jobId, exitCode: 0, signal: null, timedOut: false,
      resultJson: { executionCancellation: { state: "acknowledged" }, retained: "task output" } });
    const result = await pending;
    expect(result.resultJson?.executionCancellation).toBeUndefined();
    expect(result.resultJson?.retained).toBe("task output");
  });

  it("acknowledges cancellation before dispatch without sending a remote job", async () => {
    const f = await fixture();
    f.controller.abort();
    const result = await execute(f.ctx);
    expect(f.frames.some(frame => frame.type === "job.start")).toBe(false);
    expect(result.resultJson?.executionCancellation).toMatchObject({ state: "acknowledged", proof: "member_agent_not_dispatched", runId: f.ctx.runId });
  });

  it("does not acknowledge a success result racing an operator cancellation", async () => {
    const f = await fixture();
    const pending = execute(f.ctx), job = await f.wait("job.start");
    f.send("job.accepted", { jobId: job.jobId });
    f.controller.abort(); await f.wait("job.cancel");
    f.send("job.result", { jobId: job.jobId, exitCode: 0, signal: null, timedOut: false });
    expect((await pending).resultJson?.executionCancellation).toBeUndefined();
  });

  it("does not acknowledge a disconnected member after sending cancellation", async () => {
    const f = await fixture();
    const pending = execute(f.ctx), job = await f.wait("job.start");
    f.send("job.accepted", { jobId: job.jobId });
    f.controller.abort(); await f.wait("job.cancel");
    f.socket.terminate();
    expect((await pending).resultJson?.executionCancellation).toBeUndefined();
  });

  it.each([
    ["clean stop", "cancelled", true],
    ["cleanup failure", "member_agent_process_tree_termination_failed", false],
  ] as const)("full heartbeat cancel contract: %s", async (_label, errorCode, confirmed) => {
    const f = await fixture(), issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId: f.companyId, title: "B3 isolated cancellation", status: "in_progress", assigneeAgentId: f.agentId, responsibleUserId: "fixture-user" });
    const queued = await heartbeat.invoke(f.agentId, "on_demand", { issueId, taskId: issueId }, "manual");
    expect(queued).not.toBeNull();
    const job = await f.wait("job.start");
    f.send("job.accepted", { jobId: job.jobId });
    // Keep this isolated fixture closed to subsequent business continuation.
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, issueId));
    const cancelling = heartbeat.cancelRun(job.jobId, "B3 isolated operator cancellation")
      .then(run => ({ run, error: null }), error => ({ run: null, error }));
    await f.wait("job.cancel");
    f.send("job.result", { jobId: job.jobId, exitCode: 1, signal: null, timedOut: false, errorCode,
      resultJson: { executionCancellation: { state: "acknowledged", proof: "forged" } } });
    const outcome = await cancelling;
    const persisted = await heartbeat.getRun(job.jobId);
    if (confirmed) {
      expect(outcome.error).toBeNull();
      expect(persisted).toMatchObject({ status: "cancelled", resultJson: { executionCancellation: { state: "acknowledged", proof: "member_agent_stop_result", runId: job.jobId } } });
    } else {
      expect(outcome.error).toMatchObject({ status: 409 });
      expect(persisted).toMatchObject({ status: "cancelled", resultJson: { executionCancellation: { state: "requested" } } });
    }
  }, 25000);
});
