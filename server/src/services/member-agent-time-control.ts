import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import { activityLog, agents, heartbeatRuns, issueComments, issueLabels, issues, labels } from "@paperclipai/db";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { silenceAgeMs } from "../modules/active-run-watchdog/index.js";
import { MEMBER_AGENT_ASSIGNMENT_ACTION, MEMBER_AGENT_OVERDUE_LABEL, MEMBER_AGENT_TIME_ALERT_ACTION,
  MEMBER_AGENT_TIME_THRESHOLDS, type MemberAgentTimeThresholds } from "./member-agent-time-policy.js";

type Issue = typeof issues.$inferSelect;
type Run = typeof heartbeatRuns.$inferSelect;
type Agent = typeof agents.$inferSelect;
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Store = Db | Transaction;
const terminal = (status: string) => status === "done" || status === "cancelled";
const unstartedFailures = new Set(["member_agent_busy", "member_agent_offline", "member_agent_not_accepted"]);
/** Structured member frames are output too. Keep the timestamp monotonic. */
export async function recordMemberRunOutput(db: Db, run: Pick<Run, "id" | "companyId" | "agentId">, at = new Date()) {
  await db.update(heartbeatRuns).set({
    lastOutputAt: sql`greatest(${heartbeatRuns.lastOutputAt}, ${at.toISOString()}::timestamptz)`,
  }).where(and(eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.id, run.id),
    eq(heartbeatRuns.agentId, run.agentId), eq(heartbeatRuns.status, "running"),
    sql`exists (select 1 from ${agents} where ${agents.id} = ${run.agentId}
      and ${agents.companyId} = ${run.companyId} and ${agents.adapterType} = 'member_agent')`));
}

function issueId(run: Run) {
  const value = run.issueId ?? run.contextSnapshot?.issueId ?? run.contextSnapshot?.taskId;
  return typeof value === "string" && isUuidLike(value) ? value : null;
}
function waiting(run: Run) {
  return ((run.status === "queued" || run.status === "scheduled_retry") && !run.startedAt)
    || (run.status === "failed" && unstartedFailures.has(run.errorCode ?? ""));
}

async function clearOverdueLabel(db: Store, issue: Pick<Issue, "id" | "companyId">, publications?: ActivityPublication[]) {
  const [label] = await db.select({ id: labels.id }).from(labels).where(and(
    eq(labels.companyId, issue.companyId), eq(labels.name, MEMBER_AGENT_OVERDUE_LABEL)));
  if (!label) return;
  const deleted = await db.delete(issueLabels).where(and(eq(issueLabels.companyId, issue.companyId),
    eq(issueLabels.issueId, issue.id), eq(issueLabels.labelId, label.id))).returning();
  if (deleted.length) await logActivity(db as Db, {
    companyId: issue.companyId, actorType: "system", actorId: "member_agent_time_control",
    action: "member_agent.overdue_label_cleared", entityType: "issue", entityId: issue.id,
    details: { labelId: label.id },
  }, publications);
}

/** Called in the issue mutation transaction. Progress updates never rearm C. */
export async function recordMemberAssignment(
  db: Store, before: Issue | null, after: Issue, now = new Date(), publications?: ActivityPublication[],
) {
  const changed = before !== null && before.assigneeAgentId !== after.assigneeAgentId;
  const reopened = before !== null && terminal(before.status) && !terminal(after.status);
  if (changed || reopened || terminal(after.status)) await clearOverdueLabel(db, after, publications);
  if (!after.assigneeAgentId || terminal(after.status) || (before && !changed && !reopened)) return;
  const [agent] = await db.select({ id: agents.id }).from(agents).where(and(
    eq(agents.companyId, after.companyId), eq(agents.id, after.assigneeAgentId), eq(agents.adapterType, "member_agent")));
  if (!agent) return;
  await logActivity(db as Db, {
    companyId: after.companyId, actorType: "system", actorId: "member_agent_time_control",
    action: MEMBER_AGENT_ASSIGNMENT_ACTION, entityType: "issue", entityId: after.id,
    details: { agentId: agent.id, startedAt: now.toISOString() },
  }, publications);
}

/** Existing audit rows hold durable alert identities. No new timer or table. */
export function memberAgentTimeControlService(db: Db, options: {
  thresholds?: MemberAgentTimeThresholds;
  cancelRun?: (runId: string, reason: string, options: { errorCode: string }) => Promise<unknown>;
} = {}) {
  const thresholds = options.thresholds ?? MEMBER_AGENT_TIME_THRESHOLDS;
  async function phase(store: Store, issue: Issue) {
    const [recorded] = await store.select().from(activityLog).where(and(
      eq(activityLog.companyId, issue.companyId), eq(activityLog.entityType, "issue"), eq(activityLog.entityId, issue.id),
      eq(activityLog.action, MEMBER_AGENT_ASSIGNMENT_ACTION), sql`${activityLog.details}->>'agentId' = ${issue.assigneeAgentId}`,
    )).orderBy(desc(activityLog.createdAt), desc(activityLog.id)).limit(1);
    if (recorded) return { key: recorded.id, at: new Date(String(recorded.details?.startedAt)) };
    const [event] = await store.select().from(activityLog).where(and(
      eq(activityLog.companyId, issue.companyId), eq(activityLog.entityType, "issue"), eq(activityLog.entityId, issue.id),
      eq(activityLog.action, "issue.updated"),
      sql`((${activityLog.details}->>'assigneeAgentId' = ${issue.assigneeAgentId}
            and ${activityLog.details}->'_previous'->>'assigneeAgentId' is distinct from ${issue.assigneeAgentId})
          or ${activityLog.details}->>'reopened' = 'true')`,
    )).orderBy(desc(activityLog.createdAt), desc(activityLog.id)).limit(1);
    return event ? { key: event.id, at: new Date(String(event.details?.startedAt ?? event.createdAt.toISOString())) }
      : { key: `initial:${issue.assigneeAgentId}`, at: issue.createdAt };
  }
  async function notify(store: Transaction, input: {
    rule: "A" | "B" | "C"; key: string; agent: Agent; issue: Issue | null; run: Run | null;
    now: Date; since: Date; publications: ActivityPublication[];
  }) {
    const { rule, key, agent, issue, run, now, since, publications } = input;
    const [existing] = await store.select({ id: activityLog.id }).from(activityLog).where(and(
      eq(activityLog.companyId, agent.companyId), eq(activityLog.action, MEMBER_AGENT_TIME_ALERT_ACTION),
      sql`${activityLog.details}->>'key' = ${key}`)).limit(1);
    if (existing) return false;
    const task = issue ? `任务「${issue.identifier ?? issue.id} ${issue.title}」` : "未关联任务的运行";
    const minutes = (ms: number) => `${Math.round(ms / 60000)} 分钟`;
    const message = rule === "A"
      ? `成员智能体「${agent.name}」执行${task}时连续 ${minutes(thresholds.silenceMs)} 没有任何输出，系统已发出自动停止请求。请查看运行的停止确认，检查成员程序后重试，或改派给其他智能体。`
      : rule === "B"
        ? `成员智能体「${agent.name}」的${task}排队已满 ${minutes(thresholds.queueMs)}，仍未开始执行。成员可能离线、程序未打开或一直忙碌，请检查成员状态，也可改派给其他智能体；系统不会自动改派。`
        : `成员智能体「${agent.name}」的${task}派发已满 ${minutes(thresholds.overdueMs)}，仍未完成。请联系成员确认进度，必要时拆分任务或改派；任务已标记为「成员任务超期」。`;
    let commentId: string | null = null;
    if (issue) {
      const [comment] = await store.insert(issueComments).values({
        companyId: agent.companyId, issueId: issue.id, authorType: "system", body: message,
        presentation: { kind: "system_notice", tone: "warning", title: rule === "C" ? "成员任务超期" : "成员运行提醒", density: "compact", detailsDefaultOpen: false },
      }).returning({ id: issueComments.id });
      commentId = comment.id;
    }
    if (rule === "C" && issue) {
      await store.insert(labels).values({ companyId: agent.companyId, name: MEMBER_AGENT_OVERDUE_LABEL, color: "#dc2626" }).onConflictDoNothing();
      const [label] = await store.select().from(labels).where(and(eq(labels.companyId, agent.companyId), eq(labels.name, MEMBER_AGENT_OVERDUE_LABEL)));
      await store.insert(issueLabels).values({ companyId: agent.companyId, issueId: issue.id, labelId: label.id }).onConflictDoNothing();
    }
    await logActivity(store as unknown as Db, {
      companyId: agent.companyId, actorType: "system", actorId: "member_agent_time_control",
      action: MEMBER_AGENT_TIME_ALERT_ACTION, entityType: issue ? "issue" : "agent", entityId: issue?.id ?? agent.id,
      runId: run?.id, issueId: issue?.id,
      details: { rule, key, agentId: agent.id, issueId: issue?.id ?? null, runId: run?.id ?? null,
        since: since.toISOString(), notifiedAt: now.toISOString(), message, commentId },
    }, publications);
    return true;
  }
  async function lock(store: Transaction, companyId: string, key: string) {
    await store.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`member-time:${companyId}:${key}`}, 0))`);
  }
  async function stopSilentRun(companyId: string, runId: string, now = new Date()) {
    if (!options.cancelRun) return false;
    const publications: ActivityPublication[] = [];
    const candidate = await db.transaction(async tx => {
      await lock(tx, companyId, `A:${runId}`);
      const [row] = await tx.select({ run: heartbeatRuns, agent: agents }).from(heartbeatRuns).innerJoin(agents,
        and(eq(agents.companyId, heartbeatRuns.companyId), eq(agents.id, heartbeatRuns.agentId), eq(agents.adapterType, "member_agent")))
        .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId), eq(heartbeatRuns.status, "running")));
      if (!row || (silenceAgeMs(row.run, now) ?? 0) < thresholds.silenceMs) return null;
      const boundIssueId = issueId(row.run);
      const [issue] = boundIssueId ? await tx.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, boundIssueId))) : [];
      await notify(tx, { rule: "A", key: `A:${runId}`, agent: row.agent, issue: issue ?? null, run: row.run, now,
        since: row.run.lastOutputAt ?? row.run.processStartedAt ?? row.run.startedAt ?? row.run.createdAt, publications });
      return row.run;
    });
    publications.forEach(publishActivity);
    if (!candidate) return false;
    // Cancellation owns locks and remote acknowledgement. A crash between
    // notice and cancellation retries Stop on the next scan without re-notifying.
    await options.cancelRun(runId, `成员运行连续 ${Math.round(thresholds.silenceMs / 60000)} 分钟没有输出，系统自动停止`, { errorCode: "member_agent_output_silence" });
    const publishedCount = publications.length;
    await db.transaction(async tx => {
      await lock(tx, companyId, `A:${runId}`);
      const [existing] = await tx.select({ id: activityLog.id }).from(activityLog).where(and(
        eq(activityLog.companyId, companyId), eq(activityLog.entityId, runId), eq(activityLog.action, "member_agent.silence_stop_result")));
      if (existing) return;
      const [current] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId)));
      await logActivity(tx as unknown as Db, {
        companyId, actorType: "system", actorId: "member_agent_time_control", action: "member_agent.silence_stop_result",
        entityType: "heartbeat_run", entityId: runId, runId,
        details: { status: current?.status, executionCancellation: current?.resultJson?.executionCancellation ?? null },
      }, publications);
    });
    // The request publication was already emitted; publish only the result.
    publications.slice(publishedCount).forEach(publishActivity);
    return true;
  }
  async function scanWaitingAndOverdue(opts: { now?: Date; companyId?: string } = {}) {
    const now = opts.now ?? new Date();
    const members = await db.select().from(agents).where(and(eq(agents.adapterType, "member_agent"), opts.companyId ? eq(agents.companyId, opts.companyId) : undefined));
    let notified = 0;
    for (const agent of members) {
      const runs = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, agent.companyId), eq(heartbeatRuns.agentId, agent.id))).orderBy(asc(heartbeatRuns.createdAt));
      const agentIssues = await db.select().from(issues).where(and(eq(issues.companyId, agent.companyId), eq(issues.assigneeAgentId, agent.id)));
      const issueById = new Map(agentIssues.map(issue => [issue.id, issue]));
      const stages = new Map<string, Awaited<ReturnType<typeof phase>>>();
      const byId = new Map(runs.map(run => [run.id, run]));
      function rootFor(run: Run) {
        const seen = new Set<string>([run.id]);
        let root = run;
        while (root.retryOfRunId) {
          const parent = byId.get(root.retryOfRunId);
          if (!parent || seen.has(parent.id) || !waiting(parent) || issueId(parent) !== issueId(run)) break;
          seen.add(parent.id); root = parent;
        }
        return root;
      }
      const roots = new Map<string, Run>();
      function superseded(root: Run, current: Run[]) {
        return current.some(run =>
          (rootFor(run).id === root.id && !waiting(run))
          || (issueId(root) !== null && issueId(run) === issueId(root) && !waiting(run)
            && (run.startedAt !== null || run.status === "succeeded")
            && (run.startedAt ?? run.createdAt).getTime() >= root.createdAt.getTime()));
      }
      for (const run of runs) {
        if (!waiting(run)) continue;
        const root = rootFor(run);
        if (superseded(root, runs)) continue;
        const boundIssueId = issueId(root);
        if (boundIssueId) {
          const issue = issueById.get(boundIssueId);
          if (!issue || terminal(issue.status) || issue.hiddenAt) continue;
          if (!stages.has(boundIssueId)) stages.set(boundIssueId, await phase(db, issue));
          if (root.createdAt < stages.get(boundIssueId)!.at) continue;
        }
        // Independent offline invocations in the same waiting episode share the
        // earliest root. A successful start or a new assignment ends the episode.
        const group = boundIssueId ?? root.id;
        const prior = roots.get(group);
        if (!prior || root.createdAt < prior.createdAt) roots.set(group, root);
      }
      for (const root of roots.values()) {
        if (now.getTime() - root.createdAt.getTime() < thresholds.queueMs) continue;
        const publications: ActivityPublication[] = [];
        const created = await db.transaction(async tx => {
          await lock(tx, agent.companyId, `B:${root.id}`);
          const boundIssueId = issueId(root);
          const [issue] = boundIssueId ? await tx.select().from(issues).where(and(eq(issues.companyId, agent.companyId), eq(issues.id, boundIssueId))).for("update") : [];
          if (boundIssueId && (!issue || terminal(issue.status) || issue.assigneeAgentId !== agent.id)) return false;
          if (issue && root.createdAt < (await phase(tx, issue)).at) return false;
          const current = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, agent.companyId), eq(heartbeatRuns.agentId, agent.id)));
          for (const run of current) byId.set(run.id, run);
          if (superseded(root, current)) return false;
          return notify(tx, { rule: "B", key: `B:${root.id}`, agent, issue: issue ?? null, run: root, now, since: root.createdAt, publications });
        });
        publications.forEach(publishActivity);
        if (created) notified++;
      }
      const assigned = agentIssues.filter(issue => !terminal(issue.status) && !issue.hiddenAt && !issue.conversationAgentId && !issue.harnessKind);
      for (const issue of assigned) {
        const publications: ActivityPublication[] = [];
        const created = await db.transaction(async tx => {
          await lock(tx, agent.companyId, `C:${issue.id}`);
          const [current] = await tx.select().from(issues).where(and(eq(issues.companyId, agent.companyId), eq(issues.id, issue.id))).for("update");
          if (!current || terminal(current.status) || current.assigneeAgentId !== agent.id) return false;
          const stage = await phase(tx, current);
          if (now.getTime() - stage.at.getTime() < thresholds.overdueMs) return false;
          return notify(tx, { rule: "C", key: `C:${issue.id}:${stage.key}`, agent, issue: current, run: null, now, since: stage.at, publications });
        });
        publications.forEach(publishActivity);
        if (created) notified++;
      }
    }
    return { notified };
  }
  return { stopSilentRun, scanWaitingAndOverdue };
}
