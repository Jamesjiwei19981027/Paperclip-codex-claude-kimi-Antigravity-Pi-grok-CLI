import type { Issue } from "@paperclipai/shared";
import { Badge } from "@/components/ui/badge";

/** The server owns this reserved label; ordinary task labels keep their existing display. */
export function MemberAgentOverdueBadge({ issue }: {
  issue: Pick<Issue, "labels" | "status" | "assigneeAgentId">;
}) {
  if (!issue.assigneeAgentId || issue.status === "done" || issue.status === "cancelled"
    || !issue.labels?.some(label => label.name === "成员任务超期")) return null;
  return <Badge variant="destructive">成员任务超期</Badge>;
}
