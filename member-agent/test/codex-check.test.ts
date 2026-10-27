import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("../src/codex-cli.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/codex-cli.ts")>();
  return {
    ...actual,
    // Only the executable's version subprocess is replaced; all file checks are real.
    inspectCodexInstallation: (input: Parameters<typeof actual.inspectCodexInstallation>[0]) =>
      actual.inspectCodexInstallation(input, { getVersion: async () => "0.160.0" }),
  };
});
vi.mock("../src/connection.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/connection.ts")>(),
  connectLoop: vi.fn(async () => 0),
}));
import { main } from "../src/main.ts";
import { connectLoop } from "../src/connection.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("check code-mode host preflight", () => {
  it.each([false, true])("check returns the correct exit code and independent diagnostic with host present=%s", async (present) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "member-host-check-")); roots.push(root);
    const codexHome = path.join(root, "fake-codex-home");
    const runtimeDir = path.join(root, "runtime");
    await mkdir(codexHome);
    await mkdir(path.join(runtimeDir, "server", "dist"), { recursive: true });
    await mkdir(path.join(runtimeDir, "skills", "paperclip"), { recursive: true });
    for (const name of ["codex-local.mjs", "codex-auth-merge-decision.cjs", "codex-auth-merge-extract.sh"])
      await writeFile(path.join(runtimeDir, "server", "dist", name), "FAKE-asset");
    await writeFile(path.join(runtimeDir, "MANIFEST.json"), "{}");
    await writeFile(path.join(root, "codex.exe"), "FAKE-executable");
    await writeFile(path.join(codexHome, "auth.json"), "FAKE-login-existence-only");
    if (present) await writeFile(path.join(root, "codex-code-mode-host.exe"), "FAKE-host");
    const configPath = path.join(root, "config.json");
    await writeFile(configPath, JSON.stringify({
      serverUrl: "http://127.0.0.1:1", executor: "codex", projectDirs: {}, defaultCwd: "",
      codexExecutable: path.join(root, "codex.exe"), codexHome, runtimeDir,
    }));
    vi.stubEnv("APPDATA", root);
    vi.stubEnv("PAPERCLIP_AGENT_KEY", "FAKE-agent-key-host-check");
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation(line => { lines.push(String(line)); });
    vi.spyOn(console, "error").mockImplementation(line => { lines.push(String(line)); });
    const code = await main(["check", "--config", configPath]);
    const output = lines.join("\n");
    expect(code, output).toBe(present ? 0 : 2);
    expect(output).toContain(present ? "通过：Codex 工具宿主" : "失败：Codex 工具宿主");
    expect(output).toContain("codex-code-mode-host.exe");
    if (!present) {
      expect(output).toContain("同一版本");
      expect(output).toContain("同一目录");
    }
    expect(vi.mocked(connectLoop)).toHaveBeenCalledTimes(present ? 1 : 0);
  });
});
