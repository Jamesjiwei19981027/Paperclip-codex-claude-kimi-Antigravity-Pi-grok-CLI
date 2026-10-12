import { describe, expect, it } from "vitest";
import { buildGeminiCliArgs } from "./cli-args.js";

describe("buildGeminiCliArgs", () => {
  it("uses Antigravity headless flags without legacy Gemini approval flags", () => {
    expect(buildGeminiCliArgs({
      flavor: "antigravity",
      model: "gemini-3.8-flash-high",
      sandbox: false,
      extraArgs: [],
      resumeSessionId: "conversation-123",
      prompt: "Implement the assigned task.",
      cwd: "D:\\worktree",
    })).toEqual([
      "--output-format", "stream-json",
      "--conversation", "conversation-123",
      "--model", "gemini-3.8-flash-high",
      "--dangerously-skip-permissions",
      "--print-timeout", "0",
      "--add-dir", "D:\\worktree",
      "--prompt", "Implement the assigned task.",
    ]);
  });
});
