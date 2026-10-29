import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getUIAdapter } from "../registry";
import { buildTranscript } from "../transcript";

const ts = "2026-10-28T00:00:00.000Z";
const toolsStdout = readFileSync(new URL("./fixtures/codebuddy-tools.jsonl", import.meta.url), "utf8");
const defaultStdout = readFileSync(new URL("./fixtures/codebuddy-default.jsonl", import.meta.url), "utf8");
const authFailureStdout = readFileSync(new URL("./fixtures/codebuddy-auth-failure.jsonl", import.meta.url), "utf8");
const codexStdout = readFileSync(new URL("./fixtures/codex-stdout.jsonl", import.meta.url), "utf8");

function transcript(stdout: string) {
  return buildTranscript([{ ts, stream: "stdout", chunk: stdout }], getUIAdapter("member_agent"));
}

describe("member_agent CodeBuddy stream-json", () => {
  it("renders captured tool calls, tool results, assistant text, and success usage", () => {
    const entries = transcript(toolsStdout);

    expect(entries.map((entry) => entry.kind)).toEqual([
      "init", "stdout", "tool_call", "tool_result", "assistant", "result",
    ]);
    expect(entries).toContainEqual({ kind: "init", ts, model: "codebuddy-model", sessionId: "tools-id-1" });
    expect(entries).toContainEqual({
      kind: "tool_call", ts, name: "PowerShell", toolUseId: "tools-id-6",
      input: { command: "<redacted>", description: "<redacted>" },
    });
    expect(entries).toContainEqual({
      kind: "tool_result", ts, toolUseId: "tools-id-6", content: "<redacted output>", isError: false,
    });
    expect(entries).toContainEqual({ kind: "assistant", ts, text: "DONE" });
    expect(entries.at(-1)).toEqual({
      kind: "result", ts, text: "DONE", inputTokens: 50271, outputTokens: 66,
      cachedTokens: 27904, costUsd: 0, subtype: "success", isError: false, errors: [],
    });
  });

  it("surfaces the captured authentication failure as a failed result", () => {
    const entries = transcript(authFailureStdout);

    expect(entries).toContainEqual({ kind: "assistant", ts, text: "Authentication failed (details redacted)" });
    expect(entries.at(-1)).toEqual({
      kind: "result", ts, text: "", inputTokens: 0, outputTokens: 0, cachedTokens: 0,
      costUsd: 0, subtype: "error_during_execution", isError: true,
      errors: ["Authentication failed (details redacted)"],
    });
  });

  it("retains the completed transcript when CodeBuddy repeats init after its result", () => {
    const entries = transcript(defaultStdout);

    // Existing transcript semantics append init entries; they do not start a new run.
    expect(entries.map((entry) => entry.kind)).toEqual(["init", "stdout", "assistant", "result", "init"]);
    expect(entries.filter((entry) => entry.kind === "init")).toEqual([
      { kind: "init", ts, model: "codebuddy-model", sessionId: "default-id-1" },
      { kind: "init", ts, model: "codebuddy-model", sessionId: "default-id-1" },
    ]);
    expect(entries).toContainEqual({ kind: "assistant", ts, text: "<redacted output>" });
    expect(entries.filter((entry) => entry.kind === "result")).toEqual([
      expect.objectContaining({ inputTokens: 24880, outputTokens: 2, cachedTokens: 2944, isError: false }),
    ]);
  });

  it("handles split JSONL, CRLF, an unterminated final line, and other streams", () => {
    const crlf = toolsStdout.trimEnd().replaceAll("\n", "\r\n");
    const splitAt = crlf.indexOf("tool_use") + 5;
    const entries = buildTranscript([
      { ts, stream: "stdout", chunk: crlf.slice(0, splitAt) },
      { ts, stream: "stderr", chunk: "CodeBuddy warning\n" },
      { ts, stream: "system", chunk: "member connected" },
      { ts, stream: "stdout", chunk: crlf.slice(splitAt) },
    ], getUIAdapter("member_agent"));

    expect(entries.filter((entry) => entry.kind !== "stderr" && entry.kind !== "system")).toEqual(transcript(toolsStdout));
    expect(entries).toContainEqual({ kind: "stderr", ts, text: "CodeBuddy warning\n" });
    expect(entries).toContainEqual({ kind: "system", ts, text: "member connected" });
    expect(entries.at(-1)).toEqual(expect.objectContaining({ kind: "result", isError: false }));
  });

  it("selects each line independently when CodeBuddy and Codex outputs share a transcript", () => {
    const entries = transcript(toolsStdout + codexStdout + defaultStdout);

    expect(entries.filter((entry) => entry.kind === "assistant").map((entry) => entry.text)).toEqual([
      "DONE", "MEMBER_AGENT_PHASE3_INTEGRATION_OK", "<redacted output>",
    ]);
    expect(entries.filter((entry) => entry.kind === "result").map((entry) => [entry.inputTokens, entry.outputTokens])).toEqual([
      [50271, 66], [17, 4], [24880, 2],
    ]);
    expect(entries.filter((entry) => entry.kind === "init")).toHaveLength(4);
  });

  it("keeps Codex errors distinct from Claude results and preserves unknown or malformed lines", () => {
    const lines = [
      '{"type":"error","message":"Codex failure"}',
      '{"type":"stream_event","event":{"type":"message_start"}}',
      '{"type":"unknown","message":{"content":[{"type":"text","text":"opaque"}]}}',
      '{"type":"assistant.invalid","message":{"content":[{"type":"text","text":"opaque"}]}}',
      "null", "[]", "42", '{"type":null}', "plain text", "{invalid-json",
    ];

    expect(transcript(lines.join("\n"))).toEqual([
      { kind: "stderr", ts, text: "Codex failure" },
      ...lines.slice(1).map((text) => ({ kind: "stdout", ts, text })),
    ]);
  });
});
