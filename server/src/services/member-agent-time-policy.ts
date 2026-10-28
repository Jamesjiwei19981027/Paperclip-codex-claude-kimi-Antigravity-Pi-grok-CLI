/** Server policy only; services accept overrides for deterministic clock tests. */
export const MEMBER_AGENT_TIME_THRESHOLDS = Object.freeze({
  silenceMs: 15 * 60 * 1000,
  queueMs: 10 * 60 * 1000,
  overdueMs: 2 * 60 * 60 * 1000,
});
export type MemberAgentTimeThresholds = { [K in keyof typeof MEMBER_AGENT_TIME_THRESHOLDS]: number };
export const MEMBER_AGENT_OVERDUE_LABEL = "成员任务超期";
export const MEMBER_AGENT_TIME_ALERT_ACTION = "member_agent.time_alert";
export const MEMBER_AGENT_ASSIGNMENT_ACTION = "member_agent.assignment_started";
