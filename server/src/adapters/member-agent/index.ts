import type { ServerAdapterModule } from "../types.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

export const memberAgentAdapter: ServerAdapterModule = {
  type: "member_agent", runtimeToolDelivery: "environment", execute, testEnvironment,
  models: [], supportsLocalAgentJwt: true, supportsInstructionsBundle: false,
  agentConfigurationDoc: `Members connect outbound to /api/member-agent/v1/connect using their agent API key in the Authorization header. Authenticated deployment is required. maxRunSec defaults to 3600 and must be an integer from 1 to 14400. Stage 1 accepts no nonempty extraArgs. Model, command, cwd and env are never dispatched from server config; the member owns its tool and project directories. Codex is installed manually at the pinned version. Runtime connection tools are delivered through runtimeTools; their tokens expire after one hour and are not renewed. Native MCP discovery, resources/prompts and managed gateway configuration are not provided. Reports must include the local branch, changed files, and test commands/results. Code synchronization and physical-device testing belong to members. Submit review through a real reviewer/confirmation path, not an in_review status alone.`,
};
