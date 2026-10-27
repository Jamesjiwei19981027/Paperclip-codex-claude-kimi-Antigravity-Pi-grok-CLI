import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCodexExecutor, type CodexExecutorDependencies, type CodexRuntimeConfig } from "../src/executors/codex.ts";
import type { ExecutorHooks, JobStart } from "../src/executors/types.ts";

const temporary: string[] = [];
async function tempDir(prefix: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporary.push(directory);
  return directory;
}
afterEach(async () => { await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

function job(overrides: Partial<JobStart> = {}): JobStart {
  return {
    v: 1, type: "job.start", jobId: "run-1", companyId: "company-1", agent: { id: "agent-1", name: "Member Codex" },
    authToken: "FAKE-RUN-TOKEN-ONLY-FOR-TEST", context: { projectId: "project-1", paperclipWorkspace: { projectId: "project-1", cwd: "D:\\server\\work", worktreePath: "D:\\server\\tree", source: "project" } },
    config: { maxRunSec: 17 }, runtime: { sessionId: "session-1", sessionParams: { cwd: "D:\\server\\work", sessionId: "session-1" } },
    runtimeTools: null, handoffMarkdown: "  prior handoff  ", codeSyncDir: "D:\\server\\sync", ...overrides,
  };
}

async function setup() {
  const root = await tempDir("paperclip-codex-test-");
  const configDir = path.join(root, "agent-config");
  const project = path.join(root, "project");
  const codexHome = path.join(root, "agent-codex-home");
  const runtimeDir = path.join(root, "runtime");
  await Promise.all([mkdir(configDir), mkdir(project), mkdir(path.join(runtimeDir, "server", "dist"), { recursive: true }), mkdir(path.join(runtimeDir, "skills", "paperclip"), { recursive: true })]);
  await writeFile(path.join(runtimeDir, "server", "dist", "codex-local.mjs"), "// fake bundle\n");
  await writeFile(path.join(runtimeDir, "server", "dist", "codex-auth-merge-decision.cjs"), "// fake asset\n");
  await writeFile(path.join(runtimeDir, "server", "dist", "codex-auth-merge-extract.sh"), "# fake asset\n");
  await writeFile(path.join(runtimeDir, "skills", "paperclip", "SKILL.md"), "fake skill\n");
  await writeFile(path.join(root, "codex-code-mode-host.exe"), "FAKE-code-mode-host");
  const config: CodexRuntimeConfig = { codexExecutable: path.join(root, "codex.exe"), codexHome, runtimeDir, projectDirs: { "project-1": project }, defaultCwd: "", configDir };
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", TEMP: os.tmpdir(), USERPROFILE: root,
    PAPERCLIP_AGENT_KEY: "FAKE-AGENT-KEY-ONLY-FOR-TEST", OPENAI_API_KEY: "FAKE-OPENAI-KEY-ONLY-FOR-TEST",
    ANTHROPIC_API_KEY: "FAKE-ANTHROPIC-KEY-ONLY-FOR-TEST", CODEX_HOME: path.join(root, ".codex"), RANDOM_SECRET: "FAKE-OTHER-SECRET",
  };
  return { root, configDir, project, codexHome, runtimeDir, config, env };
}

function hooks(task: JobStart, serverUrl = "http://10.0.0.5:3100"): ExecutorHooks {
  return { job: task, serverUrl, signal: new AbortController().signal, log: vi.fn(), event: vi.fn() };
}

function dependencies(capture: (context: Record<string, unknown>) => void, env: NodeJS.ProcessEnv, overrides: Partial<CodexExecutorDependencies> = {}): CodexExecutorDependencies {
  return {
    processEnv: env,
    materializeSkills: async () => undefined,
    loadRuntime: async () => ({ execute: async (context) => { capture(context); return { exitCode: 0, signal: null, timedOut: false, unexpected: "drop me" }; } }),
    warn: vi.fn(),
    ...overrides,
  };
}

describe("Codex executor context and privacy boundary", () => {
  it.each(["fresh", "resume", "recovery", "unscoped"])("injects credential-free REST instructions on every %s run and every selected task carrier", async (mode) => {
    const fixture = await setup();
    let delivered: Record<string, unknown> | undefined;
    const context = mode === "unscoped" ? {} : {
      projectId: "project-1", paperclipTaskMarkdown: "Original task",
      paperclipTaskMarkdownAssignment: "Assignment task",
      paperclipTaskMarkdownCompact: "Compact task", paperclipTaskMarkdownAssignmentCompact: "Compact assignment",
      ...(mode === "recovery" ? { wakeReason: "issue_recovery_requested", paperclipWake: { reason: "issue_recovery_requested" } } : {}),
    };
    const config = mode === "unscoped" ? { ...fixture.config, defaultCwd: fixture.project } : fixture.config;
    const task = job({ context, ...(mode === "fresh" ? { runtime: {} } : {}) });
    await createCodexExecutor(config, dependencies(value => { delivered = value; }, fixture.env)).execute(hooks(task));
    const actual = delivered?.context as Record<string, unknown>;
    expect(actual.runtimeToolDelivery).toBe("environment");
    for (const field of ["paperclipTaskMarkdown", "paperclipTaskMarkdownAssignment", "paperclipTaskMarkdownCompact", "paperclipTaskMarkdownAssignmentCompact"]) {
      const text = String(actual[field] ?? "");
      expect(text, field).toContain("没有 Paperclip 原生工具");
      expect(text).toContain(path.join(fixture.codexHome, "skills", "paperclip", "SKILL.md"));
      for (const name of ["PAPERCLIP_API_URL", "PAPERCLIP_API_KEY", "PAPERCLIP_RUN_ID", "X-Paperclip-Run-Id", "Invoke-RestMethod"]) expect(text).toContain(name);
      expect(text).not.toMatch(/\b(resolve|call_api|update_task|complete_task|resolve_review)\b/);
      for (const secret of [task.authToken, "FAKE-AGENT-KEY-ONLY-FOR-TEST", "FAKE-OPENAI-KEY-ONLY-FOR-TEST"]) expect(text).not.toContain(secret);
    }
    if (mode !== "unscoped") {
      expect(actual.paperclipTaskMarkdown).toContain("Original task");
      expect(actual.paperclipTaskMarkdownAssignment).toContain("Assignment task");
      expect(actual.paperclipTaskMarkdownCompact).toContain("Compact task");
      expect(actual.paperclipTaskMarkdownAssignmentCompact).toContain("Compact assignment");
    }
  });
  it("fails before loading or running Codex when the sibling code-mode host is missing", async () => {
    const fixture = await setup();
    await rm(path.join(fixture.root, "codex-code-mode-host.exe"));
    let launched = false;
    const result = await createCodexExecutor(fixture.config, dependencies(() => { launched = true; }, fixture.env, {
      loadRuntime: async () => { launched = true; throw new Error("must not launch"); },
    })).execute(hooks(job()));
    expect(result).toMatchObject({ exitCode: 1, errorCode: "member_agent_runtime_missing" });
    expect(result.errorMessage).toContain("codex-code-mode-host.exe");
    expect(result.errorMessage).toContain("同一版本");
    expect(launched).toBe(false);
  });

  it("runs the adapter when the sibling code-mode host exists", async () => {
    const fixture = await setup();
    let launched = false;
    const result = await createCodexExecutor(fixture.config, dependencies(() => { launched = true; }, fixture.env)).execute(hooks(job()));
    expect(result.exitCode).toBe(0);
    expect(launched).toBe(true);
  });
  it("constructs the cli context, localizes both cwd fields, and strips secrets from process.env", async () => {
    const fixture = await setup();
    let context: Record<string, unknown> | undefined;
    const warnings: string[] = [];
    const deps = dependencies((value) => { context = value; }, fixture.env, { warn: (message) => warnings.push(message) });
    const result = await createCodexExecutor(fixture.config, deps).execute(hooks(job()));

    expect(result.exitCode).toBe(0);
    expect(context).toBeDefined();
    expect(context?.runId).toBe("run-1");
    expect(context?.agent).toEqual({ id: "agent-1", companyId: "company-1", name: "Member Codex", adapterType: "codex_local", adapterConfig: {} });
    expect(context?.executionTarget).toEqual({ kind: "local" });
    expect(context?.authToken).toBe("FAKE-RUN-TOKEN-ONLY-FOR-TEST");
    const contextConfig = context?.config as Record<string, unknown>;
    expect(contextConfig.engine).toBe("cli");
    expect(contextConfig.command).toBe(fixture.config.codexExecutable);
    expect(contextConfig.cwd).toBe(fixture.project);
    expect(contextConfig.timeoutSec).toBe(17);
    expect(contextConfig.graceSec).toBe(20);
    expect(contextConfig.model).toBeUndefined();
    expect(contextConfig.extraArgs).toEqual([]);
    expect(contextConfig.managedAiConnection).toBe(true);
    expect(contextConfig.env).toEqual({ CODEX_HOME: fixture.codexHome });
    const runtime = context?.runtime as Record<string, unknown>;
    expect((runtime.sessionParams as Record<string, unknown>).cwd).toBe(fixture.project);
    expect((runtime.sessionParams as Record<string, unknown>).sessionId).toBe("session-1");
    const localized = context?.context as Record<string, unknown>;
    expect((localized.paperclipWorkspace as Record<string, unknown>).cwd).toBe(fixture.project);
    expect((localized.paperclipWorkspace as Record<string, unknown>).agentHome).toBe(path.join(fixture.configDir, "agents", "agent-1", "home"));
    expect((localized.paperclipWorkspace as Record<string, unknown>).worktreePath).toBeUndefined();
    expect(localized.paperclipWorkspaces).toBeUndefined();
    expect(context).not.toHaveProperty("agentIdentity");
    expect(context).not.toHaveProperty("runtimeMcp");
    expect(context).not.toHaveProperty("startupTraceContext");
    expect(context).not.toHaveProperty("executionTransport");
    expect(fixture.env.PAPERCLIP_AGENT_KEY).toBeUndefined();
    expect(fixture.env.OPENAI_API_KEY).toBeUndefined();
    expect(fixture.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(fixture.env.RANDOM_SECRET).toBeUndefined();
    expect(fixture.env.PAPERCLIP_API_URL).toBe("http://10.0.0.5:3100");
    expect(fixture.env.CODEX_HOME).toBe(fixture.codexHome);
    expect(warnings).toContain("Codex 结果含 1 个不支持字段，已丢弃。");
  });

  it("passes runtime tool access with endpoints rebased to the agent server origin", async () => {
    const fixture = await setup();
    let context: Record<string, unknown> | undefined;
    const task = job({ runtimeTools: {
      version: 1, guidance: "fake guidance", mcpEndpoint: "http://localhost:3100/api/mcp/run", rest: {
        connectionsSearch: "http://127.0.0.1:3100/api/connections/search", connectionRequest: "http://paperclip.internal:3100/api/connections/request",
      }, bearerToken: "FAKE-RUNTIME-TOOL-TOKEN-ONLY-FOR-TEST", expiresAt: "2030-01-01T00:00:00.000Z", tools: ["connections.search"],
    } });
    await createCodexExecutor(fixture.config, dependencies((value) => { context = value; }, fixture.env)).execute(hooks(task, "https://board.example"));
    expect((context?.config as Record<string, any>).env).toEqual({
      CODEX_HOME: fixture.codexHome,
      PAPERCLIP_RUNTIME_TOOLS_MCP_URL: "https://board.example/api/mcp/run",
      PAPERCLIP_RUNTIME_TOOLS_TOKEN: "FAKE-RUNTIME-TOOL-TOKEN-ONLY-FOR-TEST",
      PAPERCLIP_RUNTIME_TOOLS_EXPIRES_AT: "2030-01-01T00:00:00.000Z",
      PAPERCLIP_RUNTIME_TOOLS_CONNECTIONS_SEARCH_URL: "https://board.example/api/connections/search",
      PAPERCLIP_RUNTIME_TOOLS_CONNECTION_REQUEST_URL: "https://board.example/api/connections/request",
      PAPERCLIP_RUNTIME_TOOLS_AVAILABLE: "connections.search",
      PAPERCLIP_RUNTIME_TOOLS_GUIDANCE: "fake guidance",
    });
  });

  it("returns prior handoff text and removes legacy server handoff copies", async () => {
    const fixture = await setup();
    let context: Record<string, unknown> | undefined;
    let getFresh: (() => Promise<unknown>) | undefined;
    await createCodexExecutor(fixture.config, dependencies((value) => { context = value; }, fixture.env, {
      loadRuntime: async () => ({ execute: async (value) => { context = value; getFresh = value.getFreshSessionHandoff as () => Promise<unknown>; return { exitCode: 0, signal: null, timedOut: false }; } }),
    })).execute(hooks(job({ context: { projectId: "project-1", paperclipSessionHandoffMarkdown: "old D:\\server\\path", paperclipContinuationSummary: "old summary" } })));
    expect(await getFresh?.()).toBe("  prior handoff  ");
    expect(context?.context).not.toHaveProperty("paperclipSessionHandoffMarkdown");
    expect(context?.context).not.toHaveProperty("paperclipContinuationSummary");
  });

  it("returns null for an empty handoff", async () => {
    const fixture = await setup();
    let getFresh: (() => Promise<unknown>) | undefined;
    await createCodexExecutor(fixture.config, dependencies(() => undefined, fixture.env, {
      loadRuntime: async () => ({ execute: async (value) => { getFresh = value.getFreshSessionHandoff as () => Promise<unknown>; return { exitCode: 0, signal: null, timedOut: false }; } }),
    })).execute(hooks(job({ handoffMarkdown: "  \n" })));
    expect(await getFresh?.()).toBeNull();
  });

  it("uses the default directory when the project id is absent", async () => {
    const fixture = await setup();
    let context: Record<string, unknown> | undefined;
    const config = { ...fixture.config, projectDirs: {}, defaultCwd: fixture.project };
    const result = await createCodexExecutor(config, dependencies((value) => { context = value; }, fixture.env)).execute(hooks(job({ context: {} })));
    expect(result.exitCode).toBe(0);
    expect((context?.config as Record<string, unknown>).cwd).toBe(fixture.project);
  });

  it("keeps two project mappings isolated across consecutive Codex tasks", async () => {
    const fixture = await setup();
    const secondProject = path.join(fixture.root, "second-project");
    await mkdir(secondProject);
    const config = { ...fixture.config, projectDirs: { ...fixture.config.projectDirs, "project-2": secondProject } };
    const contexts: Array<Record<string, unknown>> = [];
    const executor = createCodexExecutor(config, dependencies(() => undefined, fixture.env, {
      loadRuntime: async () => ({ execute: async (value) => {
        contexts.push(value);
        return { exitCode: 0, signal: null, timedOut: false, summary: String(value.runId) };
      } }),
    }));

    const firstResult = await executor.execute(hooks(job()));
    const secondResult = await executor.execute(hooks(job({
      jobId: "run-2",
      context: { projectId: "project-2", paperclipWorkspace: { projectId: "project-2", cwd: "D:\\other-server\\work" } },
      runtime: { sessionId: "session-2", sessionParams: { cwd: "D:\\other-server\\work", sessionId: "session-2" } },
    })));

    expect(firstResult.summary).toBe("run-1");
    expect(secondResult.summary).toBe("run-2");
    expect((contexts[0].config as Record<string, unknown>).cwd).toBe(fixture.project);
    expect(((contexts[0].context as Record<string, any>).paperclipWorkspace).cwd).toBe(fixture.project);
    expect((contexts[1].config as Record<string, unknown>).cwd).toBe(secondProject);
    expect(((contexts[1].context as Record<string, any>).paperclipWorkspace).cwd).toBe(secondProject);
    expect((contexts[1].runtime as Record<string, any>).sessionParams.cwd).toBe(secondProject);
  });

  it.each([
    ["missing project mapping", (base: CodexRuntimeConfig) => ({ ...base, projectDirs: {} }), job(), "member_agent_cwd_unresolved"],
    ["missing mapped directory", (base: CodexRuntimeConfig) => ({ ...base, projectDirs: { "project-1": path.join(os.tmpdir(), "no-such-member-agent-dir") } }), job(), "member_agent_cwd_missing"],
    ["path under agent config", (base: CodexRuntimeConfig) => ({ ...base, projectDirs: { "project-1": path.join(base.configDir, "inside") } }), job(), "member_agent_cwd_unresolved"],
    ["parent segment", (base: CodexRuntimeConfig) => ({ ...base, projectDirs: { "project-1": `${base.configDir}\\..\\project` } }), job(), "member_agent_cwd_unresolved"],
    ["UNC path", (base: CodexRuntimeConfig) => ({ ...base, projectDirs: { "project-1": "\\\\server\\share\\repo" } }), job(), "member_agent_cwd_unresolved"],
    ["no project id and no default", (base: CodexRuntimeConfig) => ({ ...base, projectDirs: {} }), job({ context: {} }), "member_agent_cwd_unresolved"],
  ])("fails closed for %s", async (_name, makeConfig, task, code) => {
    const fixture = await setup();
    const result = await createCodexExecutor(makeConfig(fixture.config), dependencies(() => undefined, fixture.env)).execute(hooks(task));
    expect(result.errorCode).toBe(code);
  });

  it("rejects non-exe command paths", async () => {
    const fixture = await setup();
    const result = await createCodexExecutor({ ...fixture.config, codexExecutable: "codex.cmd" }, dependencies(() => undefined, fixture.env)).execute(hooks(job()));
    expect(result.errorCode).toBe("member_agent_configuration_error");
    expect(result.errorMessage).toContain("codexExecutable");
  });

  it("reports a missing bundled runtime with the prescribed recovery guidance", async () => {
    const fixture = await setup();
    await rm(path.join(fixture.runtimeDir, "server", "dist", "codex-auth-merge-decision.cjs"));
    const result = await createCodexExecutor(fixture.config, dependencies(() => undefined, fixture.env)).execute(hooks(job()));
    expect(result.errorCode).toBe("member_agent_runtime_missing");
    expect(result.errorMessage).toContain("重新运行 build-runtime");
    expect(result.errorMessage).not.toContain("ENOENT");
  });

  it("fails the task when bundled skills cannot be installed", async () => {
    const fixture = await setup();
    const result = await createCodexExecutor(fixture.config, dependencies(() => undefined, fixture.env, {
      materializeSkills: async () => { throw new Error("disk denied"); },
    })).execute(hooks(job()));
    expect(result.errorCode).toBe("member_agent_skill_install_failed");
    expect(result.errorMessage).toContain("技能");
    expect(result.errorMessage).not.toContain("disk denied");
  });

  it("maps a failing adapter exit without an error code to the Codex failure code", async () => {
    const fixture = await setup();
    const result = await createCodexExecutor(fixture.config, dependencies(() => undefined, fixture.env, {
      loadRuntime: async () => ({ execute: async () => ({ exitCode: 2, signal: null, timedOut: false }) }),
    })).execute(hooks(job()));
    expect(result.errorCode).toBe("member_agent_codex_failed");
  });

  it("converts adapter exceptions to a short safe result without stack text", async () => {
    const fixture = await setup();
    const result = await createCodexExecutor(fixture.config, dependencies(() => undefined, fixture.env, {
      loadRuntime: async () => ({ execute: async () => { throw new Error(`private stack ${"FAKE-RUN-TOKEN-ONLY-FOR-TEST"}`); } }),
    })).execute(hooks(job()));
    expect(result.errorCode).toBe("member_agent_executor_error");
    expect(result.errorMessage).toBe("Codex 执行器发生错误，请检查本机日志。");
    expect(JSON.stringify(result)).not.toContain("FAKE-RUN-TOKEN");
  });

  it("maps spawn, meta, event, and usage callbacks", async () => {
    const fixture = await setup();
    const meta = vi.fn(), event = vi.fn(), usage = vi.fn(), childSpawned = vi.fn();
    let ctx: Record<string, unknown> | undefined;
    const task = job({ runtimeTools: null });
    const executor = createCodexExecutor(fixture.config, dependencies((value) => { ctx = value; }, fixture.env, {
      loadRuntime: async () => ({ execute: async (value) => {
        (value.onMeta as (x: unknown) => void)({ adapterType: "codex_local", command: "codex.exe" });
        (value.onEvent as (x: unknown) => void)({ eventType: "progress" });
        (value.onUsage as (x: unknown) => void)({ complete: false });
        (value.onSpawn as (x: unknown) => void)({ pid: 321 });
        (value.onSpawn as (x: unknown) => void)({ pid: -1 });
        ctx = value;
        return { exitCode: 0, signal: null, timedOut: false };
      } }),
    }));
    await executor.execute({ ...hooks(task), meta, event, usage, childSpawned } as ExecutorHooks);
    expect(meta).toHaveBeenCalledWith({ adapterType: "codex_local", command: "codex.exe" });
    expect(event).toHaveBeenCalledWith({ eventType: "progress" });
    expect(usage).toHaveBeenCalledWith({ complete: false });
    expect(childSpawned).toHaveBeenCalledTimes(1);
    expect(childSpawned).toHaveBeenCalledWith(321);
    expect(ctx).toBeDefined();
  });
});
