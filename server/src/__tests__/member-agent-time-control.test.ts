import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { activityLog, agents, companies, createDb, heartbeatRuns, issueComments, issueLabels, issues, labels } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { memberAgentTimeControlService, recordMemberAssignment, recordMemberRunOutput } from "../services/member-agent-time-control.js";
import { attentionService } from "../services/attention.js";
import { issueService } from "../services/issues.js";
import { createActiveRunWatchdog } from "../modules/active-run-watchdog/index.js";

describe("成员智能体时间控制（持久化集成）", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const origin = new Date("2026-10-28T00:00:00Z");
  const at = (ms: number) => new Date(origin.getTime() + ms);
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("member-time-");
    db = createDb(database.connectionString);
  }, 120000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  async function fixture(adapterType = "member_agent", status = "queued") {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "时间控制", issuePrefix: "T" + companyId.slice(0, 7) });
    const [agent] = await db.insert(agents).values({ companyId, name: "小林", adapterType, status: "idle" }).returning();
    const [issue] = await db.insert(issues).values({ companyId, title: "核对订单", identifier: "TC-" + randomUUID(), assigneeAgentId: agent.id, status: "todo", createdAt: origin }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent.id, scopeKind: "issue", issueId: issue.id, contextSnapshot: { issueId: issue.id }, status, createdAt: origin, startedAt: status === "running" ? origin : null }).returning();
    const cancel = async (runId: string) => {
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: at(900000) }).where(eq(heartbeatRuns.id, runId));
    };
    const service = () => memberAgentTimeControlService(db, { cancelRun: cancel });
    const notices = () => db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "member_agent.time_alert")));
    return { companyId, agent, issue, run, service, notices };
  }
  for (const rule of ["A", "B", "C"] as const) {
    const threshold = { A: 900000, B: 600000, C: 7200000 }[rule];
    async function scan(f: Awaited<ReturnType<typeof fixture>>, now: Date) {
      const service = f.service();
      if (rule === "A") await createActiveRunWatchdog(db, {
        suspicionThresholdMs: 300000, criticalThresholdMs: 900000, continueRearmMs: 1800000,
        stopSilentMemberRun: (run, scanNow) => service.stopSilentRun(run.companyId, run.id, scanNow),
      }).scanSilentActiveRuns({ companyId: f.companyId, now });
      else await service.scanWaitingAndOverdue({ companyId: f.companyId, now });
    }
    describe(`规则 ${rule}`, () => {
      it("未到阈值不触发", async () => {
        const f = await fixture("member_agent", rule === "A" ? "running" : rule === "B" ? "queued" : "succeeded");
        await scan(f, at(threshold - 1));
        expect(await f.notices()).toHaveLength(0);
      });
      it("阈值整点触发一次，重建服务后不重复", async () => {
        const f = await fixture("member_agent", rule === "A" ? "running" : rule === "B" ? "queued" : "succeeded");
        await scan(f, at(threshold));
        await scan(f, at(threshold + 1));
        await scan(f, at(threshold + 1000));
        const notices = await f.notices();
        expect(notices).toHaveLength(1);
        expect(notices[0].details).toMatchObject({ rule, agentId: f.agent.id, issueId: f.issue.id });
        expect(String(notices[0].details?.message)).toContain("小林");
        expect(String(notices[0].details?.message)).toContain("核对订单");
        const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issue.id));
        expect(comments).toHaveLength(1);
        if (rule === "A") {
          const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id));
          expect(run.status).toBe("cancelled");
        }
        if (rule === "C") {
          const marked = await db.select().from(issueLabels).innerJoin(labels, eq(labels.id, issueLabels.labelId)).where(eq(issueLabels.issueId, f.issue.id));
          expect(marked.map(row => row.labels.name)).toEqual(["成员任务超期"]);
        }
      });
      it.each(["process", "codex_local"])("非成员 %s 不触发", async adapter => {
        const f = await fixture(adapter, rule === "A" ? "running" : rule === "B" ? "queued" : "succeeded");
        await scan(f, at(threshold + 1));
        expect(await f.notices()).toHaveLength(0);
      });
    });
  }
  it("A 最近有输出时重新计时，即使任务 blocked 仍执行静默保护", async () => {
    const f = await fixture("member_agent", "running");
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, f.issue.id));
    await db.update(heartbeatRuns).set({ lastOutputAt: at(300000) }).where(eq(heartbeatRuns.id, f.run.id));
    await f.service().stopSilentRun(f.companyId, f.run.id, at(900000));
    expect(await f.notices()).toHaveLength(0);
    await f.service().stopSilentRun(f.companyId, f.run.id, at(1200000));
    expect(await f.notices()).toHaveLength(1);
  });
  it("A 取消失败后重建服务会重试停止，但不重复通知", async () => {
    const f = await fixture("member_agent", "running");
    const failed = memberAgentTimeControlService(db, { cancelRun: async () => { throw new Error("连接中断"); } });
    await expect(failed.stopSilentRun(f.companyId, f.run.id, at(900000))).rejects.toThrow("连接中断");
    await f.service().stopSilentRun(f.companyId, f.run.id, at(900001));
    expect(await f.notices()).toHaveLength(1);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id));
    expect(run.status).toBe("cancelled");
  });
  it("B 忙碌重试继承首次排队时间和通知身份", async () => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ status: "failed", startedAt: at(1000), errorCode: "member_agent_busy" }).where(eq(heartbeatRuns.id, f.run.id));
    const [retry] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agent.id, scopeKind: "issue", issueId: f.issue.id, contextSnapshot: { issueId: f.issue.id }, status: "scheduled_retry", retryOfRunId: f.run.id, scheduledRetryAt: at(900000), createdAt: at(590000) }).returning();
    await f.service().scanWaitingAndOverdue({ companyId: f.companyId, now: at(600000) });
    expect(await f.notices()).toHaveLength(1);
    await db.update(heartbeatRuns).set({ status: "queued" }).where(eq(heartbeatRuns.id, retry.id));
    await f.service().scanWaitingAndOverdue({ companyId: f.companyId, now: at(600001) });
    expect(await f.notices()).toHaveLength(1);
  });
  it("B 离线快速失败仍在十分钟时提醒，实际执行的后继消除等待", async () => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ status: "failed", startedAt: at(1000), errorCode: "member_agent_offline" }).where(eq(heartbeatRuns.id, f.run.id));
    await f.service().scanWaitingAndOverdue({ companyId: f.companyId, now: at(600000) });
    expect(await f.notices()).toHaveLength(1);
    const g = await fixture();
    await db.update(heartbeatRuns).set({ status: "failed", errorCode: "member_agent_busy" }).where(eq(heartbeatRuns.id, g.run.id));
    await db.insert(heartbeatRuns).values({ companyId: g.companyId, agentId: g.agent.id, scopeKind: "issue", issueId: g.issue.id, status: "running", retryOfRunId: g.run.id, startedAt: at(300000), createdAt: at(200000) });
    await g.service().scanWaitingAndOverdue({ companyId: g.companyId, now: at(600000) });
    expect(await g.notices()).toHaveLength(0);
  });
  it.each(["done", "cancelled"])("C %s 的任务不提醒", async status => {
    const f = await fixture("member_agent", "succeeded");
    await db.update(issues).set({ status }).where(eq(issues.id, f.issue.id));
    await f.service().scanWaitingAndOverdue({ companyId: f.companyId, now: at(7200000) });
    expect(await f.notices()).toHaveLength(0);
  });
  it("C 同阶段更新不重置，改派及重开开启新阶段并清除旧标记", async () => {
    const f = await fixture("member_agent", "succeeded");
    await f.service().scanWaitingAndOverdue({ companyId: f.companyId, now: at(7200000) });
    await recordMemberAssignment(db, f.issue, { ...f.issue, status: "in_progress" }, at(7200001));
    await f.service().scanWaitingAndOverdue({ companyId: f.companyId, now: at(7200002) });
    expect(await f.notices()).toHaveLength(1);
    const reopened = { ...f.issue, status: "todo" };
    await recordMemberAssignment(db, { ...f.issue, status: "done" }, reopened, at(8000000));
    expect(await db.select().from(issueLabels).where(eq(issueLabels.issueId, f.issue.id))).toHaveLength(0);
    await f.service().scanWaitingAndOverdue({ companyId: f.companyId, now: at(15199999) });
    expect(await f.notices()).toHaveLength(1);
    await f.service().scanWaitingAndOverdue({ companyId: f.companyId, now: at(15200000) });
    expect(await f.notices()).toHaveLength(2);
  });
  it("并发扫描只写一条通知、评论和标签", async () => {
    const f = await fixture("member_agent", "succeeded");
    await Promise.all([f.service(), f.service()].map(service => service.scanWaitingAndOverdue({ companyId: f.companyId, now: at(7200000) })));
    expect(await f.notices()).toHaveLength(1);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issue.id))).toHaveLength(1);
  });
  it("公司边界不允许对外公司的运行执行停止", async () => {
    const f = await fixture("member_agent", "running");
    const g = await fixture();
    await f.service().stopSilentRun(g.companyId, f.run.id, at(900000));
    expect(await f.notices()).toHaveLength(0);
  });
  it("阈值可注入且不会影响默认值", async () => {
    const f = await fixture("member_agent", "succeeded");
    const service = memberAgentTimeControlService(db, { thresholds: { silenceMs: 10, queueMs: 20, overdueMs: 30 } });
    await service.scanWaitingAndOverdue({ companyId: f.companyId, now: at(30) });
    expect(await f.notices()).toHaveLength(1);
  });
  it("真实 attention 收件箱显示中文提醒，完成任务清除超期标签", async () => {
    const f = await fixture("member_agent", "succeeded");
    await f.service().scanWaitingAndOverdue({ companyId: f.companyId, now: at(7200000) });
    const feed = await attentionService(db).list(f.companyId);
    const alerts = feed.items.filter(item => item.sourceKind === "member_agent_time_alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ severity: "high", relatedIssue: { id: f.issue.id }, inlineResolvable: false });
    expect(alerts[0].subject.title).toContain("小林");
    expect(alerts[0].subject.href).toContain(f.issue.identifier);
    await issueService(db).update(f.issue.id, { status: "done" });
    expect(await db.select().from(issueLabels).where(eq(issueLabels.issueId, f.issue.id))).toHaveLength(0);
  });
  it("真实改派记录新阶段，同一负责人重复赋值不重置时间", async () => {
    const f = await fixture("member_agent", "succeeded");
    const [other] = await db.insert(agents).values({ companyId: f.companyId, name: "小周", adapterType: "member_agent", status: "idle" }).returning();
    const service = issueService(db);
    await service.update(f.issue.id, { assigneeAgentId: other.id });
    const phases = () => db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId), eq(activityLog.action, "member_agent.assignment_started")));
    expect(await phases()).toHaveLength(1);
    await service.update(f.issue.id, { assigneeAgentId: other.id });
    expect(await phases()).toHaveLength(1);
    const phase = (await phases())[0];
    const assigned = new Date(String(phase.details?.startedAt));
    await f.service().scanWaitingAndOverdue({ companyId: f.companyId, now: new Date(assigned.getTime() + 7199999) });
    expect(await f.notices()).toHaveLength(0);
    await f.service().scanWaitingAndOverdue({ companyId: f.companyId, now: new Date(assigned.getTime() + 7200000) });
    expect(await f.notices()).toHaveLength(1);
  });
  it("A 结构化输出也重置静默时钟，非成员和终止运行不受影响", async () => {
    const f = await fixture("member_agent", "running");
    await recordMemberRunOutput(db, f.run, at(600000));
    await f.service().stopSilentRun(f.companyId, f.run.id, at(900000));
    expect(await f.notices()).toHaveLength(0);
    await f.service().stopSilentRun(f.companyId, f.run.id, at(1500000));
    expect(await f.notices()).toHaveLength(1);
    await recordMemberRunOutput(db, f.run, at(1600000));
    const [ended] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id));
    expect(ended.lastOutputAt).toEqual(at(600000));
    const g = await fixture("process", "running");
    await recordMemberRunOutput(db, g.run, at(600000));
    const [unrelated] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, g.run.id));
    expect(unrelated.lastOutputAt).toBeNull();
  });
  it("A 超过一百条既有非成员静默运行不会挤掉成员保护", async () => {
    const f = await fixture("member_agent", "running");
    const [other] = await db.insert(agents).values({ companyId: f.companyId, name: "已有服务", adapterType: "process" }).returning();
    await db.insert(heartbeatRuns).values(Array.from({ length: 101 }, () => ({
      companyId: f.companyId, agentId: other.id, status: "running", createdAt: at(-1000), startedAt: at(-1000),
    })));
    await createActiveRunWatchdog(db, {
      suspicionThresholdMs: 300000, criticalThresholdMs: 900000, continueRearmMs: 1800000,
      stopSilentMemberRun: (run, now) => f.service().stopSilentRun(run.companyId, run.id, now),
    }).scanSilentActiveRuns({ companyId: f.companyId, now: at(900000) });
    expect(await f.notices()).toHaveLength(1);
  });
  it("A 不能在五分钟时将已完成任务的远程运行静默折叠为成功", async () => {
    const f = await fixture("member_agent", "running");
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issue.id));
    await db.insert(activityLog).values({ companyId: f.companyId, actorType: "agent", actorId: f.agent.id,
      agentId: f.agent.id, runId: f.run.id, action: "issue.updated", entityType: "issue", entityId: f.issue.id,
      details: { status: "done" }, createdAt: at(1000) });
    const scan = () => createActiveRunWatchdog(db, {
      suspicionThresholdMs: 300000, criticalThresholdMs: 900000, continueRearmMs: 1800000,
      stopSilentMemberRun: (run, now) => f.service().stopSilentRun(run.companyId, run.id, now),
    });
    await scan().scanSilentActiveRuns({ companyId: f.companyId, now: at(300000) });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0].status).toBe("running");
    await scan().scanSilentActiveRuns({ companyId: f.companyId, now: at(900000) });
    expect(await f.notices()).toHaveLength(1);
  });
  it("C 历史阶段回退不能读取其他公司的重开事件", async () => {
    const f = await fixture("member_agent", "succeeded");
    const foreign = await fixture("member_agent", "succeeded");
    await db.insert(activityLog).values({ companyId: foreign.companyId, actorType: "system", actorId: "fixture",
      action: "issue.updated", entityType: "issue", entityId: foreign.issue.id, details: { reopened: true }, createdAt: at(7000000) });
    await f.service().scanWaitingAndOverdue({ companyId: f.companyId, now: at(7200000) });
    expect(await f.notices()).toHaveLength(1);
    expect(await foreign.notices()).toHaveLength(0);
  });
  it("B 普通派发的新运行已执行时，不再为旧离线失败提醒", async () => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ status: "failed", errorCode: "member_agent_offline", startedAt: at(1000) }).where(eq(heartbeatRuns.id, f.run.id));
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agent.id, scopeKind: "issue", issueId: f.issue.id,
      status: "running", createdAt: at(300000), startedAt: at(300000) });
    await f.service().scanWaitingAndOverdue({ companyId: f.companyId, now: at(600000) });
    expect(await f.notices()).toHaveLength(0);
  });
  it("B 同阶段多次独立离线派发只提醒一次", async () => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ status: "failed", errorCode: "member_agent_offline", startedAt: at(1000) }).where(eq(heartbeatRuns.id, f.run.id));
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agent.id, scopeKind: "issue", issueId: f.issue.id,
      status: "failed", errorCode: "member_agent_offline", createdAt: at(10000), startedAt: at(11000) });
    await f.service().scanWaitingAndOverdue({ companyId: f.companyId, now: at(610000) });
    expect(await f.notices()).toHaveLength(1);
  });
  it.each(["release", "adminForceRelease"] as const)("C %s 取消负责人时清除超期标签", async method => {
    const f = await fixture("member_agent", "succeeded");
    await f.service().scanWaitingAndOverdue({ companyId: f.companyId, now: at(7200000) });
    const service = issueService(db);
    if (method === "release") await service.release(f.issue.id);
    else await service.adminForceRelease(f.issue.id, { clearAssignee: true });
    expect(await db.select().from(issueLabels).where(eq(issueLabels.issueId, f.issue.id))).toHaveLength(0);
  });
  it("C 原子领取未分派的旧任务时，从领取派活时刻计时", async () => {
    const f = await fixture("member_agent", "succeeded");
    await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, f.issue.id));
    await issueService(db).checkout(f.issue.id, f.agent.id, ["todo"], null);
    const [stage] = await db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId), eq(activityLog.action, "member_agent.assignment_started")));
    const assigned = new Date(String(stage.details?.startedAt));
    await f.service().scanWaitingAndOverdue({ companyId: f.companyId, now: new Date(assigned.getTime() + 7199999) });
    expect(await f.notices()).toHaveLength(0);
    await f.service().scanWaitingAndOverdue({ companyId: f.companyId, now: new Date(assigned.getTime() + 7200000) });
    expect(await f.notices()).toHaveLength(1);
  });
  it("B 改派回同一成员后，不继承上一个派活阶段的离线失败", async () => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ status: "failed", errorCode: "member_agent_offline" }).where(eq(heartbeatRuns.id, f.run.id));
    await recordMemberAssignment(db, { ...f.issue, assigneeAgentId: null }, f.issue, at(1000000));
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agent.id, scopeKind: "issue", issueId: f.issue.id,
      status: "queued", createdAt: at(1000001) });
    await f.service().scanWaitingAndOverdue({ companyId: f.companyId, now: at(1600000) });
    expect(await f.notices()).toHaveLength(0);
    await f.service().scanWaitingAndOverdue({ companyId: f.companyId, now: at(1600001) });
    expect(await f.notices()).toHaveLength(1);
  });
});
