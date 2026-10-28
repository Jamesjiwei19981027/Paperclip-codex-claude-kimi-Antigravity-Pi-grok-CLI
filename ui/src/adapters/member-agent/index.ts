import { parseCodexStdoutLine } from "@paperclipai/adapter-codex-local/ui";
import type { UIAdapterModule } from "../types";
import { SchemaConfigFields, buildSchemaAdapterConfig } from "../schema-config-fields";

export const memberAgentUIAdapter: UIAdapterModule = {
  type: "member_agent",
  label: "member_agent",
  // Members currently execute Codex only. Select by executor when more are supported.
  parseStdoutLine: parseCodexStdoutLine,
  // Preserve the schema-based configuration used before this adapter was registered.
  ConfigFields: SchemaConfigFields,
  buildAdapterConfig: buildSchemaAdapterConfig,
};
