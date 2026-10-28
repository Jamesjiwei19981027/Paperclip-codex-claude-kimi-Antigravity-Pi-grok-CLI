import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getUIAdapter } from "../registry";
import { buildTranscript, type RunLogChunk } from "../transcript";
import { SchemaConfigFields, buildSchemaAdapterConfig } from "../schema-config-fields";
import type { CreateConfigValues } from "../types";

const ts = "2026-10-26T22:32:37.000Z";
// Captured job.log stdout from real Codex 0.160.0 with a loopback fake model:
// doc/plans/2026-10-26-member-agent-integration-flake-evidence/temp-probe-runs/run-05.log
const stdout = readFileSync(new URL("./fixtures/codex-stdout.jsonl", import.meta.url), "utf8");
const chunks: RunLogChunk[] = [{ ts, stream: "stdout", chunk: stdout }];

describe("member_agent UI adapter", () => {
  it("demonstrates why the process fallback loses structured Codex messages", () => {
    const processEntries = buildTranscript(chunks, getUIAdapter("process"));
    const codexEntries = buildTranscript(chunks, getUIAdapter("codex_local"));
    const memberEntries = buildTranscript(chunks, getUIAdapter("member_agent"));

    console.info(JSON.stringify({ sample: "real Codex 0.160.0 job.log", processEntries, codexEntries, memberEntries }, null, 2));
    expect(processEntries.map((entry) => entry.kind)).toEqual(["stdout", "stdout", "stdout", "stdout", "stdout"]);
    expect(codexEntries.map((entry) => entry.kind)).toEqual(["init", "stderr", "system", "assistant", "result"]);
    expect(codexEntries).toContainEqual({ kind: "assistant", ts, text: "MEMBER_AGENT_PHASE3_INTEGRATION_OK" });
    expect(memberEntries).toEqual(codexEntries);
  });

  it("renders captured member stdout as assistant text and usage instead of raw JSON", () => {
    const entries = buildTranscript(chunks, getUIAdapter("member_agent"));

    expect(entries).toContainEqual({ kind: "assistant", ts, text: "MEMBER_AGENT_PHASE3_INTEGRATION_OK" });
    expect(entries.map((entry) => entry.kind)).toEqual(["init", "stderr", "system", "assistant", "result"]);
    expect(entries).toContainEqual(expect.objectContaining({ kind: "result", inputTokens: 17, outputTokens: 4, isError: false }));
  });

  it("handles split JSONL, CRLF, an unterminated final line, and non-stdout streams", () => {
    const crlf = stdout.trimEnd().replaceAll("\n", "\r\n");
    const splitAt = crlf.indexOf("agent_message") + 5;
    const entries = buildTranscript([
      { ts, stream: "stdout", chunk: crlf.slice(0, splitAt) },
      { ts, stream: "stderr", chunk: "member warning\n" },
      { ts, stream: "system", chunk: "member connected" },
      { ts, stream: "stdout", chunk: crlf.slice(splitAt) },
    ], getUIAdapter("member_agent"));

    expect(entries).toContainEqual({ kind: "assistant", ts, text: "MEMBER_AGENT_PHASE3_INTEGRATION_OK" });
    expect(entries).toContainEqual({ kind: "stderr", ts, text: "member warning\n" });
    expect(entries).toContainEqual({ kind: "system", ts, text: "member connected" });
    expect(entries.at(-1)).toEqual(expect.objectContaining({ kind: "result", inputTokens: 17, outputTokens: 4 }));
  });

  it("preserves Codex thinking and tool entries while retaining plain-text fallback", () => {
    const lines = [
      { type: "item.completed", item: { id: "reasoning-1", type: "reasoning", text: "Inspecting the workspace" } },
      { type: "item.started", item: { id: "command-1", type: "command_execution", command: "git status --short" } },
      { type: "item.completed", item: { id: "command-1", type: "command_execution", command: "git status --short", status: "completed", exit_code: 0, aggregated_output: "clean\n" } },
    ];
    const entries = buildTranscript([{ ts, stream: "stdout", chunk: lines.map((line) => JSON.stringify(line)).join("\n") + "\n{not-json" }], getUIAdapter("member_agent"));

    expect(entries).toEqual([
      { kind: "thinking", ts, text: "Inspecting the workspace" },
      { kind: "tool_call", ts, name: "command_execution", toolUseId: "command-1", input: { id: "command-1", command: "git status --short" } },
      { kind: "tool_result", ts, toolUseId: "command-1", content: "command: git status --short\nstatus: completed\nexit_code: 0\n\nclean", isError: false },
      { kind: "stdout", ts, text: "{not-json" },
    ]);
  });

  it("retains the pre-existing schema configuration for forms and agent creation", () => {
    const adapter = getUIAdapter("member_agent");
    expect(adapter.ConfigFields).toBe(SchemaConfigFields);
    expect(adapter.buildAdapterConfig).toBe(buildSchemaAdapterConfig);
    const values: CreateConfigValues = {
      adapterType: "member_agent", promptTemplate: "", chrome: false, dangerouslySkipPermissions: false,
      search: false, fastMode: false, dangerouslyBypassSandbox: false, args: "", envVars: "", envBindings: {},
      url: "", bootstrapPrompt: "", maxTurnsPerRun: 1, heartbeatEnabled: true, intervalSec: 60,
      model: " codex-model ", cwd: "E:/member-work", command: "member-command",
      instructionsFilePath: "AGENTS.md", thinkingEffort: "high", extraArgs: " --first  --second ",
      adapterSchemaValues: { maxRunSec: 600 },
    };
    expect(adapter.buildAdapterConfig(values)).toEqual({
      model: "codex-model", cwd: "E:/member-work", command: "member-command",
      instructionsFilePath: "AGENTS.md", thinkingEffort: "high", extraArgs: ["--first", "--second"], maxRunSec: 600,
    });
    expect(getUIAdapter("process").parseStdoutLine("ordinary log", ts)).toEqual([{ kind: "stdout", ts, text: "ordinary log" }]);
  });
});
