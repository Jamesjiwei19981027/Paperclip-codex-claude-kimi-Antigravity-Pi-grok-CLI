import type { heartbeatRuns, issues } from "@paperclipai/db";
import { parseObject } from "../../adapters/utils.js";
import { readHeartbeatRunErrorFamily } from "./retries.js";

/** Used when a quota failure did not say when the subscription window resets. */
export const PROVIDER_QUOTA_RESET_FALLBACK_MS = 60 * 60 * 1000;

/**
 * When an agent whose run hit its subscription limit may be woken again, or
 * null when the run was not a quota failure.
 */
export function providerQuotaResetDueAt(
  run: Pick<
    typeof heartbeatRuns.$inferSelect,
    "status" | "errorCode" | "resultJson" | "finishedAt" | "createdAt"
  >,
): Date | null {
  if (run.status !== "failed" || readHeartbeatRunErrorFamily(run) !== "provider_quota") return null;
  const result = parseObject(run.resultJson);
  const raw = result.providerQuotaRetryNotBefore ?? result.retryNotBefore ?? result.transientRetryNotBefore;
  if (typeof raw === "string" || typeof raw === "number") {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date((run.finishedAt ?? run.createdAt).getTime() + PROVIDER_QUOTA_RESET_FALLBACK_MS);
}

/**
 * Work the agent can act on by itself: its own open tasks, or a review stage
 * waiting on it. An in_review task it handed off waits on someone else.
 */
export function isProviderQuotaResetWakeCandidate(
  issue: Pick<typeof issues.$inferSelect, "status" | "assigneeAgentId" | "executionState">,
  agentId: string,
) {
  if (issue.status === "todo" || issue.status === "in_progress") return issue.assigneeAgentId === agentId;
  if (issue.status !== "in_review") return false;
  const state = parseObject(issue.executionState);
  const participant = parseObject(state.currentParticipant);
  return state.status === "pending" && participant.type === "agent" && participant.agentId === agentId;
}
