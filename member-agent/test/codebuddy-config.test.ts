import path from "node:path";
import { expect, it } from "vitest";
import { validateConfig } from "../src/config.ts";
const root = path.resolve("test-fixture");
const base = { serverUrl: "http://localhost:3100", executor: "codebuddy", projectDirs: {}, defaultCwd: root, codebuddyEntry: path.join(root, "bin/codebuddy"), codebuddyHome: path.join(root, "codebuddy-home"), runtimeDir: path.join(root, "runtime") };
it("accepts CodeBuddy account default and a configured model", () => {
  expect(validateConfig(base, {}, { requireAgentKey: false })).toMatchObject({ executor: "codebuddy" });
  expect(validateConfig({ ...base, codebuddyModel: " deepseek-v4.1-flash " }, {}, { requireAgentKey: false }).codebuddyModel).toBe("deepseek-v4.1-flash");
});
it.each([{ codebuddyEntry: "relative" }, { codebuddyHome: path.join(root, ".codebuddy") }, { codebuddyHome: path.join(root, ".codebuddy/member") }, { codebuddyModel: "claude-opus-5" }, { codebuddyModel: 1 }])("rejects invalid or personal CodeBuddy configuration %j", overrides => {
  expect(() => validateConfig({ ...base, ...overrides }, { USERPROFILE: root }, { requireAgentKey: false })).toThrow(/codebuddy/);
});
