import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  companyMemberships,
  companySkills,
  costEvents,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Resumed after quota reset.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn(), hashPrivateRef: (value: string) => value }),
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return { ...actual, trackAgentFirstHeartbeat: vi.fn() };
});

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: mockAdapterExecute })),
  };
});

import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres provider quota reset tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat provider quota reset wakes", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-quota-reset-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await heartbeatService(db).drainActiveRunExecutions();
    vi.clearAllMocks();
    runningProcesses.clear();
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(costEvents);
    await db.delete(workspaceOperations);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 30_000);

  async function seed(opts: { resetAt: Date; laterRun?: boolean }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    const issuePrefix = `Q${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix, requireBoardApprovalForNewAgents: false });
    // System wakes resolve their responsible user to the company owner.
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: randomUUID(), membershipRole: "owner", status: "active" });
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Director", role: "cto", status: "idle", adapterType: "claude_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: otherAgentId, companyId, name: "Lead", role: "engineer", status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    const issue = (n: number, values: Partial<typeof issues.$inferInsert>) => ({
      id: randomUUID(), companyId, title: `Issue ${n}`, priority: "medium", issueNumber: n, identifier: `${issuePrefix}-${n}`, ...values,
    });
    const todo = issue(1, { status: "todo", assigneeAgentId: agentId });
    const review = issue(2, {
      status: "in_review",
      assigneeAgentId: agentId,
      executionState: { status: "pending", currentParticipant: { type: "agent", agentId, userId: null } },
    });
    const blocked = issue(3, { status: "blocked", assigneeAgentId: agentId });
    const othersTask = issue(4, { status: "todo", assigneeAgentId: otherAgentId });
    await db.insert(issues).values([todo, review, blocked, othersTask]);

    const failedAt = new Date(Date.now() - 3 * 60 * 60 * 1000);
    await db.insert(heartbeatRuns).values({
      companyId, agentId, scopeKind: "issue", issueId: blocked.id, invocationSource: "automation",
      status: "failed", errorCode: "provider_quota",
      error: "You've hit your session limit · resets 1am (Asia/Shanghai)",
      resultJson: { errorFamily: "provider_quota", providerQuotaRetryNotBefore: opts.resetAt.toISOString() },
      createdAt: failedAt, startedAt: failedAt, finishedAt: failedAt,
    });
    if (opts.laterRun) {
      const laterAt = new Date(failedAt.getTime() + 60_000);
      await db.insert(heartbeatRuns).values({
        companyId, agentId, invocationSource: "on_demand", status: "succeeded",
        createdAt: laterAt, startedAt: laterAt, finishedAt: laterAt,
      });
    }
    return { agentId, todo, review, blocked, othersTask };
  }

  async function quotaResetWakeIssueIds(agentId: string) {
    const rows = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    return rows
      .filter((row) => row.reason === "provider_quota_reset")
      .map((row) => (row.payload as Record<string, unknown> | null)?.issueId as string)
      .sort();
  }

  it("wakes the agent for its open work and pending reviews once the limit resets", async () => {
    const fixture = await seed({ resetAt: new Date(Date.now() - 60_000) });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileProviderQuotaResetWakes();
    await heartbeat.drainActiveRunExecutions();

    expect(result).toEqual({ agentsWoken: 1, wakesRequested: 2 });
    expect(await quotaResetWakeIssueIds(fixture.agentId)).toEqual([fixture.todo.id, fixture.review.id].sort());
  });

  it("sweeps each quota failure only once", async () => {
    await seed({ resetAt: new Date(Date.now() - 60_000) });
    const heartbeat = heartbeatService(db);

    await heartbeat.reconcileProviderQuotaResetWakes();
    await heartbeat.drainActiveRunExecutions();
    expect(await heartbeat.reconcileProviderQuotaResetWakes()).toEqual({ agentsWoken: 0, wakesRequested: 0 });
  });

  it("waits until the reset time", async () => {
    const fixture = await seed({ resetAt: new Date(Date.now() + 60 * 60 * 1000) });

    expect(await heartbeatService(db).reconcileProviderQuotaResetWakes()).toEqual({ agentsWoken: 0, wakesRequested: 0 });
    expect(await quotaResetWakeIssueIds(fixture.agentId)).toEqual([]);
  });

  it("leaves an agent alone once it has run again", async () => {
    const fixture = await seed({ resetAt: new Date(Date.now() - 60_000), laterRun: true });

    expect(await heartbeatService(db).reconcileProviderQuotaResetWakes()).toEqual({ agentsWoken: 0, wakesRequested: 0 });
    expect(await quotaResetWakeIssueIds(fixture.agentId)).toEqual([]);
  });
});
