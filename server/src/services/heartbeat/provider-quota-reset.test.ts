import { describe, expect, it } from "vitest";
import {
  isProviderQuotaResetWakeCandidate,
  PROVIDER_QUOTA_RESET_FALLBACK_MS,
  providerQuotaResetDueAt,
} from "./provider-quota-reset.js";

const createdAt = new Date("2026-10-13T13:05:01.000Z");
const finishedAt = new Date("2026-10-13T13:05:09.000Z");

function run(overrides: Partial<Parameters<typeof providerQuotaResetDueAt>[0]> = {}) {
  return {
    status: "failed",
    errorCode: "provider_quota",
    resultJson: { providerQuotaRetryNotBefore: "2026-10-13T17:00:00.000Z" },
    finishedAt,
    createdAt,
    ...overrides,
  } as Parameters<typeof providerQuotaResetDueAt>[0];
}

describe("providerQuotaResetDueAt", () => {
  it("uses the reset time parsed from the limit message", () => {
    expect(providerQuotaResetDueAt(run())?.toISOString()).toBe("2026-10-13T17:00:00.000Z");
    expect(providerQuotaResetDueAt(run({ resultJson: { retryNotBefore: "2026-10-13T18:00:00.000Z" } }))?.toISOString())
      .toBe("2026-10-13T18:00:00.000Z");
  });

  it("recognizes the quota family recorded only in the result", () => {
    expect(providerQuotaResetDueAt(run({ errorCode: "adapter_failed", resultJson: { errorFamily: "provider_quota" } })))
      .not.toBeNull();
  });

  it("falls back to an hour after the failure when no reset time was given", () => {
    expect(providerQuotaResetDueAt(run({ resultJson: {} }))?.getTime())
      .toBe(finishedAt.getTime() + PROVIDER_QUOTA_RESET_FALLBACK_MS);
    expect(providerQuotaResetDueAt(run({ resultJson: { retryNotBefore: "not a date" }, finishedAt: null }))?.getTime())
      .toBe(createdAt.getTime() + PROVIDER_QUOTA_RESET_FALLBACK_MS);
  });

  it("ignores runs that did not fail on quota", () => {
    expect(providerQuotaResetDueAt(run({ status: "succeeded" }))).toBeNull();
    expect(providerQuotaResetDueAt(run({ errorCode: "claude_transient_upstream", resultJson: {} }))).toBeNull();
  });
});

describe("isProviderQuotaResetWakeCandidate", () => {
  const agentId = "agent-a";
  const pendingReview = (participantAgentId: string, status = "pending") => ({
    status,
    currentParticipant: { type: "agent", agentId: participantAgentId },
  });

  it("wakes the assignee for open work", () => {
    expect(isProviderQuotaResetWakeCandidate({ status: "todo", assigneeAgentId: agentId, executionState: null }, agentId)).toBe(true);
    expect(isProviderQuotaResetWakeCandidate({ status: "in_progress", assigneeAgentId: agentId, executionState: null }, agentId)).toBe(true);
    expect(isProviderQuotaResetWakeCandidate({ status: "todo", assigneeAgentId: "agent-b", executionState: null }, agentId)).toBe(false);
  });

  it("wakes a reviewer only for a review stage waiting on it", () => {
    expect(isProviderQuotaResetWakeCandidate({ status: "in_review", assigneeAgentId: "agent-b", executionState: pendingReview(agentId) }, agentId)).toBe(true);
    expect(isProviderQuotaResetWakeCandidate({ status: "in_review", assigneeAgentId: agentId, executionState: pendingReview("agent-b") }, agentId)).toBe(false);
    expect(isProviderQuotaResetWakeCandidate({ status: "in_review", assigneeAgentId: agentId, executionState: null }, agentId)).toBe(false);
    expect(isProviderQuotaResetWakeCandidate({ status: "in_review", assigneeAgentId: agentId, executionState: pendingReview(agentId, "approved") }, agentId)).toBe(false);
  });

  it("leaves blocked and finished work alone", () => {
    for (const status of ["blocked", "backlog", "done", "cancelled"]) {
      expect(isProviderQuotaResetWakeCandidate({ status, assigneeAgentId: agentId, executionState: null }, agentId)).toBe(false);
    }
  });
});
