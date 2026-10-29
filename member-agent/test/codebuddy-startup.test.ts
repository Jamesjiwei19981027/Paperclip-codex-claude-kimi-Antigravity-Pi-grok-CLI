import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("../src/codebuddy-cli.ts", async importOriginal => ({
  ...await importOriginal<typeof import("../src/codebuddy-cli.ts")>(),
  inspectCodeBuddyInstallation: vi.fn(),
}));
vi.mock("../src/connection.ts", async importOriginal => ({
  ...await importOriginal<typeof import("../src/connection.ts")>(),
  connectLoop: vi.fn(async () => 0),
}));
import { main } from "../src/main.ts";
import { inspectCodeBuddyInstallation } from "../src/codebuddy-cli.ts";
import { connectLoop } from "../src/connection.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function startup(command: string, inspection: Awaited<ReturnType<typeof inspectCodeBuddyInstallation>>) {
  const root = await mkdtemp(path.join(tmpdir(), "member-cb-startup-")); roots.push(root);
  await mkdir(path.join(root, "project"));
  const configPath = path.join(root, "config.json");
  await writeFile(configPath, JSON.stringify({ serverUrl: "http://127.0.0.1:1", executor: "codebuddy", projectDirs: {}, defaultCwd: path.join(root, "project"),
    codebuddyEntry: path.join(root, "codebuddy/bin/codebuddy"), codebuddyHome: path.join(root, "cb-home"), runtimeDir: path.join(root, "runtime") }));
  vi.stubEnv("APPDATA", root); vi.stubEnv("PAPERCLIP_AGENT_KEY", "FAKE-startup-key");
  vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:7897");
  vi.mocked(inspectCodeBuddyInstallation).mockResolvedValue(inspection);
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation(line => { lines.push(String(line)); });
  const code = await main([command, "--config", configPath]);
  return { code, output: lines.join("\n") };
}
const healthy = { version: "2.169.0", loggedIn: true, packageIssues: [], runtimeIssues: [], ok: true };
it.each([false, true])("run goes online with login present=%s", async loggedIn => {
  const { code, output } = await startup("run", { ...healthy, loggedIn, ok: loggedIn });
  expect(code, output).toBe(0);
  expect(connectLoop).toHaveBeenCalledOnce();
  expect(connectLoop).toHaveBeenCalledWith(expect.objectContaining({ check: false, executor: "codebuddy", executorVersion: "2.169.0" }));
  if (!loggedIn) {
    expect(output).toContain("WARN"); expect(output).toContain("警告：未发现 CodeBuddy 共享登录凭据");
    expect(output).toContain("start.ps1 -Mode login"); expect(output).toContain("member_agent_codebuddy_login_required");
  }
});
it("check still fails when login is missing", async () => {
  const { code, output } = await startup("check", { ...healthy, loggedIn: false, ok: false });
  expect(code, output).toBe(2); expect(output).toContain("失败：共享登录凭据");
  expect(connectLoop).not.toHaveBeenCalled();
});
it.each([
  { version: "2.168.0" }, { packageIssues: ["哈希不符"] }, { runtimeIssues: ["缺少运行时"] },
])("run rejects incomplete or incompatible installation: %j", async problem => {
  const { code, output } = await startup("run", { ...healthy, ...problem, loggedIn: false, ok: false });
  expect(code, output).toBe(2); expect(connectLoop).not.toHaveBeenCalled();
});
