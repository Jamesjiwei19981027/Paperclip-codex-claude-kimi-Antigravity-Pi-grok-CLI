import { parseClaudeStdoutLine } from "@paperclipai/adapter-claude-local/ui";
import { parseCodexStdoutLine } from "@paperclipai/adapter-codex-local/ui";
import type { UIAdapterModule } from "../types";
import { SchemaConfigFields, buildSchemaAdapterConfig } from "../schema-config-fields";

const claudeStreamJsonTypes = new Set(["system", "assistant", "user", "result", "stream_event"]);

function parseMemberAgentStdoutLine(line: string, ts: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return parseCodexStdoutLine(line, ts);
  }
  if (
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) &&
    "type" in parsed && typeof parsed.type === "string" && claudeStreamJsonTypes.has(parsed.type)
  ) {
    return parseClaudeStdoutLine(line, ts);
  }
  return parseCodexStdoutLine(line, ts);
}

export const memberAgentUIAdapter: UIAdapterModule = {
  type: "member_agent",
  label: "member_agent",
  // CodeBuddy uses Claude stream-json; Codex keeps its own JSONL protocol.
  parseStdoutLine: parseMemberAgentStdoutLine,
  // Preserve the schema-based configuration used before this adapter was registered.
  ConfigFields: SchemaConfigFields,
  buildAdapterConfig: buildSchemaAdapterConfig,
};
