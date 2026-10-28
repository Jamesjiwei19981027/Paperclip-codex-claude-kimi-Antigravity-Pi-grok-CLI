import { describe, expect, it } from "vitest";
import { addDecisionQueueItemSchema, createDecisionArchiveProposalSchema } from "./decision-queue.js";

describe("成员时间提醒的收件箱契约", () => {
  it("允许负责人将提醒加入队列并提出归档", () => {
    const item = { sourceKind: "member_agent_time_alert", sourceId: "alert-1" };
    expect(addDecisionQueueItemSchema.parse(item)).toEqual(item);
    expect(createDecisionArchiveProposalSchema.parse({
      items: [{ ...item, reason: "已联系成员并改派" }],
    }).items[0].reason).toBe("已联系成员并改派");
  });
});
