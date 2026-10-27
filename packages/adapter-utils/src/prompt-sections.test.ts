import { describe, expect, it } from "vitest";
import { selectPaperclipPromptSections as selectSections } from "./server-utils.js";
import { createPromptContextFixture } from "./test-fixtures/prompt-context.js";

describe("task and event section ownership", () => {
  const recoveryWake = {
    reason: "source_scoped_recovery_action",
    issue: { id: "issue-recovery", title: "Recover", status: "blocked" },
    recovery: { cause: "workspace_validation_failed", originalAssignee: { id: "agent-1", name: "Coder" } },
  };

  it("gives environment recovery runs real REST operations instead of native calls", () => {
    const { wakePrompt } = selectSections({ runtimeToolDelivery: "environment", paperclipWake: recoveryWake });
    expect(wakePrompt).not.toContain("resolve call");
    expect(wakePrompt).not.toContain("`resolve`");
    expect(wakePrompt).toContain("GET /api/issues/{id}/recovery-actions");
    expect(wakePrompt).toContain("POST /api/issues/{id}/recovery-actions/resolve");
    for (const field of ["actionId", "outcome", "sourceIssueStatus", "resolutionNote"]) expect(wakePrompt).toContain(field);
    expect(wakePrompt).toContain("X-Paperclip-Run-Id");
    expect(wakePrompt).toContain("POST /api/issues/{id}/comments");
  });

  it("keeps native recovery wording byte-for-byte unchanged", () => {
    const original = selectSections({ paperclipWake: recoveryWake }).wakePrompt;
    const native = selectSections({ runtimeToolDelivery: "native_mcp", paperclipWake: recoveryWake }).wakePrompt;
    expect(native).toBe(original);
    expect(native).toContain("Record the outcome in the resolve call's `resolutionNote`.");
  });

  it("preserves resumed wake data without reintroducing generic procedures", () => {
    const context = createPromptContextFixture();
    for (const includeExecutionContract of [undefined, false, true]) {
      const sections = selectSections(context, { resumedSession: true, includeExecutionContract });
      expect(sections.taskContextNote).toBe(context.paperclipTaskMarkdownAssignmentCompact);
      expect(sections.wakePrompt).toContain('"id":"comment-second"');
      expect(sections.wakePrompt).not.toContain("Execution contract:");
    }
  });

  it("preserves user repetition and distinct same-body comments under their source owners", () => {
    const context = createPromptContextFixture();
    const { taskContextNote, wakePrompt } = selectSections(context);
    expect(taskContextNote).toContain(context.paperclipTaskMarkdownAssignment);
    expect(taskContextNote).toContain(context.paperclipWake.issue.description);
    expect(taskContextNote).not.toContain("comment-first");
    expect(wakePrompt).not.toContain(context.paperclipWake.issue.description);
    expect(wakePrompt).not.toContain('"objective":');
    expect(wakePrompt).toContain('"objectiveSource":{"kind":"description","id":"issue-1"');
    for (const message of context.executionContinuation.messages) {
      expect(wakePrompt).toContain(`"id":"${message.id}"`);
      expect(wakePrompt).toContain(message.body);
    }
    expect(wakePrompt.indexOf('"id":"comment-first"')).toBeLessThan(wakePrompt.indexOf('"id":"comment-second"'));
    expect(wakePrompt.indexOf('"id":"comment-second"')).toBeLessThan(wakePrompt.indexOf('"id":"comment-scope"'));
    expect(wakePrompt).toContain('"sourceTrust":"human"');
    expect(wakePrompt).toContain("Untrusted continuation evidence");
    expect(wakePrompt).toContain("receipt-1");
    expect(wakePrompt).toContain("Do not repeat completed actions");
  });

  it("reselects full bootstrap and history when the attempt becomes fresh", () => {
    const context = createPromptContextFixture();
    const resumed = selectSections(context, { resumedSession: true });
    expect(resumed.taskContextNote).toBe(context.paperclipTaskMarkdownAssignmentCompact);
    expect(resumed.wakePrompt).not.toContain('"id":"comment-first"');
    const fresh = selectSections(context, { resumedSession: false });
    expect(fresh.taskContextNote).toContain(context.paperclipTaskCommunicationGuidance);
    expect(fresh.taskContextNote).toContain(context.paperclipTaskMarkdownAssignment);
    expect(fresh.wakePrompt).toContain('"id":"comment-first"');
    expect(context.executionContinuation.messages).toHaveLength(3);
  });

  it("retains old input fields and the wake description when no assignment was provided", () => {
    const context = createPromptContextFixture();
    expect(selectSections({ paperclipTaskMarkdown: "Legacy assignment" }).taskContextNote).toBe("Legacy assignment");
    const sections = selectSections({ paperclipWake: context.paperclipWake });
    expect(sections.taskContextNote).toBe("");
    expect(sections.wakePrompt).toContain(context.paperclipWake.issue.description);
  });
});
