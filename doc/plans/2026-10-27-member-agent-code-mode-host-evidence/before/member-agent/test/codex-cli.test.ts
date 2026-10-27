import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateConfig, ConfigError } from "../src/config.ts";
import { buildLoginEnvironment, hasCodexLogin, inspectCodexInstallation, missingRuntimeFiles, parseCodexVersion, runCodexLogin } from "../src/codex-cli.ts";
import { EventEmitter } from "node:events";

const roots: string[] = [];
async function tempDir() { const dir = await mkdtemp(path.join(os.tmpdir(), "member-codex-cli-")); roots.push(dir); return dir; }
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("Codex config and local checks", () => {
  it("parses stable and prerelease codex-cli versions and rejects other output", () => {
    expect(parseCodexVersion("codex-cli 0.160.0\n")).toBe("0.160.0");
    expect(parseCodexVersion("codex-cli 0.160.0-beta.2\n")).toBe("0.160.0-beta.2");
    expect(parseCodexVersion("version unavailable")).toBeNull();
  });

  it("codex executor requires all three absolute local paths and gives actionable field errors", () => {
    const input = { serverUrl: "http://127.0.0.1:3100", executor: "codex", projectDirs: {}, defaultCwd: "" };
    try { validateConfig(input, { PAPERCLIP_AGENT_KEY: "FAKE-agent-key" }); }
    catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      for (const field of ["codexExecutable", "codexHome", "runtimeDir"]) expect((error as Error).message).toContain(field);
      expect((error as Error).message).toContain("绝对路径");
      return;
    }
    throw new Error("missing codex paths must fail");
  });

  it("rejects a non-exe executable, the shared user .codex home, and unknown fields", () => {
    const root = path.resolve(os.tmpdir(), "codex-config-fixture");
    const input = { serverUrl: "http://127.0.0.1:3100", executor: "codex", projectDirs: {}, defaultCwd: "", codexExecutable: path.join(root, "codex.cmd"), codexHome: path.join(root, "home"), runtimeDir: path.join(root, "runtime"), typo: true };
    expect(() => validateConfig(input, { PAPERCLIP_AGENT_KEY: "FAKE-agent-key", USERPROFILE: root })).toThrow(/codexExecutable/);
    const sharedHome = { ...input, codexExecutable: path.join(root, "codex.exe"), codexHome: path.join(root, ".codex"), typo: undefined };
    expect(() => validateConfig(sharedHome, { PAPERCLIP_AGENT_KEY: "FAKE-agent-key", USERPROFILE: root })).toThrow(/codexHome/);
    const normalized = { ...sharedHome, codexHome: path.join(root, "member-codex"), typo: true };
    expect(() => validateConfig(normalized, { PAPERCLIP_AGENT_KEY: "FAKE-agent-key", USERPROFILE: root })).toThrow(/typo/);
  });

  it("login environment uses a dedicated CODEX_HOME and omits Paperclip/OpenAI secrets", () => {
    const env = buildLoginEnvironment({ PATH: "C:\\Windows\\System32", SystemRoot: "C:\\Windows", PAPERCLIP_AGENT_KEY: "FAKE-long-lived-agent-key", OPENAI_API_KEY: "FAKE-provider-key", CODEX_HOME: "C:\\Users\\x\\.codex" }, "C:\\member\\codex-home");
    expect(env).toEqual({ PATH: "C:\\Windows\\System32", SystemRoot: "C:\\Windows", CODEX_HOME: "C:\\member\\codex-home" });
  });

  it("check runs all independent probes even when the executable/version checks fail", async () => {
    const calls: string[] = [];
    const result = await inspectCodexInstallation({ executable: "fake-codex.exe", codexHome: "fake-home", runtimeDir: "fake-runtime" }, {
      executableReady: async () => { calls.push("executable"); return false; },
      getVersion: async () => { calls.push("version"); throw new Error("not a version"); },
      hasLogin: async () => { calls.push("login"); return false; },
      missingRuntime: async () => { calls.push("runtime"); return ["bundle"]; },
    });
    expect(calls.sort()).toEqual(["executable", "login", "runtime", "version"]);
    expect(result).toEqual({ executable: false, version: null, loggedIn: false, missingRuntime: ["bundle"] });
  });

  it("login launches fake codex.exe with device auth, inherited stdio, and sanitized environment", async () => {
    let actual: any;
    const fakeSpawn = ((file: string, args: readonly string[], options: any) => {
      actual = { file, args, options };
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("close", 0));
      return child;
    }) as any;
    const code = await runCodexLogin("C:\\fake\\codex.exe", "C:\\member\\home", { PATH: "C:\\Windows", PAPERCLIP_AGENT_KEY: "FAKE-long-lived-key", OPENAI_API_KEY: "FAKE-provider-key" }, fakeSpawn);
    expect(code).toBe(0);
    expect(actual.file).toBe("C:\\fake\\codex.exe");
    expect(actual.args).toEqual(["login", "--device-auth"]);
    expect(actual.options.stdio).toBe("inherit");
    expect(actual.options.env).toEqual({ PATH: "C:\\Windows", CODEX_HOME: "C:\\member\\home" });
  });

  it("checks auth.json existence without reading content and checks every runtime asset", async () => {
    const root = await tempDir(); const runtime = path.join(root, "runtime");
    expect(await hasCodexLogin(path.join(root, "home"))).toBe(false);
    await mkdir(path.join(root, "home"), { recursive: true });
    await writeFile(path.join(root, "home", "auth.json"), "FAKE-auth-content-must-not-be-read");
    expect(await hasCodexLogin(path.join(root, "home"))).toBe(true);
    expect(await missingRuntimeFiles(runtime)).toHaveLength(5);
    for (const relative of ["server/dist", "skills/paperclip"]) await mkdir(path.join(runtime, relative), { recursive: true });
    for (const relative of ["server/dist/codex-local.mjs", "server/dist/codex-auth-merge-decision.cjs", "server/dist/codex-auth-merge-extract.sh", "MANIFEST.json"]) await writeFile(path.join(runtime, relative), "test");
    expect(await missingRuntimeFiles(runtime)).toEqual([]);
  });
});
