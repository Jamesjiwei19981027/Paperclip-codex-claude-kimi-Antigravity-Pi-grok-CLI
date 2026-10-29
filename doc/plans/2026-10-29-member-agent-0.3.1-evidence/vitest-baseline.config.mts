import { execFileSync } from "node:child_process";
import path from "node:path";
import { defineConfig } from "vitest/config";
import server from "../../../server/vitest.config.ts";
import claude from "../../../packages/adapters/claude-local/vitest.config.ts";

const repo = path.resolve(import.meta.dirname, "../../..");
const original = execFileSync("git", ["show", "HEAD:packages/adapters/claude-local/src/server/prompt-cache.ts"], { cwd: repo, encoding: "utf8", windowsHide: true });
const originalSource = () => ({ name: "original-prompt-cache-for-baseline", enforce: "pre" as const,
  transform(_code: string, id: string) { if (id.replaceAll("\\", "/").endsWith("/claude-local/src/server/prompt-cache.ts")) return { code: original, map: null }; },
});
export default defineConfig({ test: { projects: [
  { ...claude, root: path.join(repo, "packages/adapters/claude-local"), plugins: [originalSource()], test: { ...claude.test, name: "baseline-claude", exclude: ["**/node_modules/**", "**/prompt-cache.test.ts"] } },
  { ...server, root: path.join(repo, "server"), plugins: [originalSource()], test: { ...server.test, name: "baseline-server" } },
] } });
