import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { createCodeBuddyExecutor, normalizeCodeBuddyResult } from "../src/executors/codebuddy.ts";
import type { ExecutorHooks } from "../src/executors/types.ts";
import { validateResult } from "../src/protocol.ts";
import type { ExecutorResult } from "../src/executors/types.ts";
const roots: string[] = [];
it("replays a Read tool result containing unauthorized recipients through the real claude_local runtime and normalization", async () => {
  const f = await setup();
  const stdout = await readFile(new URL("./fixtures/codebuddy-read-skill-success.jsonl", import.meta.url), "utf8");
  const skill = await readFile(new URL("../../skills/paperclip/SKILL.md", import.meta.url), "utf8");
  const toolText = JSON.parse(stdout.split("\n")[2]).message.content[0].content;
  expect(skill.split(/\r?\n/)).toContain(toolText);
  const entry = path.join(f.root, "replay.mjs");
  await writeFile(entry, `if(process.argv.includes('--version')){console.log('2.169.0')}else{process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(stdout)}))}`);
  let raw: any;
  const result = await createCodeBuddyExecutor({ ...f.config, codebuddyEntry: entry, codebuddyModel: "", runtimeDir: path.resolve("runtime") }, {
    processEnv: { ...process.env }, queryRegistry: async () => "",
    loadRuntime: async runtimeEntry => {
      const { execute } = await import((await import("node:url")).pathToFileURL(runtimeEntry).href);
      return { execute: async ctx => { raw = await execute(ctx); return raw; } };
    },
  }).execute(f.hooks);
  expect(raw).toMatchObject({ exitCode: 0, timedOut: false, errorCode: "claude_auth_required", resultJson: { type: "result", subtype: "success", is_error: false } });
  expect(result).toMatchObject({ exitCode: 0, timedOut: false, signal: null });
  expect(result).not.toHaveProperty("errorCode");
  expect(() => validateResult(result)).not.toThrow();
  console.log(`REPLAY raw=${JSON.stringify({ exitCode: raw.exitCode, errorCode: raw.errorCode, terminal: raw.resultJson })}`);
  console.log(`REPLAY normalized=${JSON.stringify(result)}`);
}, 30_000);
function authResult(): ExecutorResult & { loginUrl?: string } {
  return { exitCode: 0, signal: null, timedOut: false, errorCode: "claude_auth_required", errorMessage: "unauthorized",
    errorFamily: "configuration", errorMeta: { loginUrl: "https://example.invalid/login" }, loginUrl: "https://example.invalid/login",
    retryNotBefore: "2026-10-29T00:00:00Z", resultJson: { type: "result", subtype: "success", is_error: false, result: "完成" } };
}
it("clears only heuristic Claude auth fields after an explicit successful terminal result", () => {
  const result = normalizeCodeBuddyResult(authResult(), "");
  expect(result.exitCode).toBe(0);
  for (const field of ["errorCode", "errorMessage", "errorFamily", "errorMeta", "loginUrl", "retryNotBefore"]) expect(result).not.toHaveProperty(field);
  expect(() => validateResult(result)).not.toThrow();
});
it.each([
  { exitCode: 1 }, { exitCode: null }, { timedOut: true }, { signal: "SIGTERM" },
  { resultJson: { type: "result", subtype: "error_during_execution", is_error: true, result: "Please log in" } },
  { resultJson: { type: "result", subtype: "success", is_error: true } },
  { resultJson: { type: "result", result: "完成" } },
  { resultJson: { type: "assistant", subtype: "success" } },
])("keeps login failures when explicit success conditions are absent: %j", patch => {
  const result = normalizeCodeBuddyResult({ ...authResult(), ...patch }, "");
  expect(result.errorCode).toBe("member_agent_codebuddy_login_required");
});
it.each(["provider_quota", "duplex_channel_lost", "member_agent_process_tree_termination_failed"])("preserves other real failure codes after a success terminal: %s", errorCode => {
  expect(normalizeCodeBuddyResult({ ...authResult(), errorCode }, "").errorCode).toBe(errorCode);
});
it("rejects the zero-token empty terminal run", () => {
  const result = normalizeCodeBuddyResult({ exitCode: 0, signal: null, timedOut: false, summary: "", usage: { inputTokens: 0, outputTokens: 0 }, resultJson: { type: "result", result: "", is_error: false } }, "");
  expect(result).toMatchObject({ exitCode: 1, errorCode: "member_agent_codebuddy_empty_run", errorMessage: "CodeBuddy 未收到任务内容或未执行，请重试；如反复出现请把日志发给负责人。" });
  expect(() => validateResult(result)).not.toThrow();
});
it.each(["你好", "好"])("preserves a short normal reply: %s", text => {
  expect(normalizeCodeBuddyResult({ exitCode: 0, signal: null, timedOut: false, usage: { inputTokens: 0, outputTokens: 0 }, resultJson: { type: "result", result: text } }, "").exitCode).toBe(0);
});
it("preserves an assistant message even with an empty terminal result and zero usage", async () => {
  const f = await setup();
  const result = await createCodeBuddyExecutor(f.config, { processEnv: {}, queryRegistry: async () => "", loadRuntime: async () => ({ execute: async (ctx: any) => {
    const line = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "好" }] } }) + "\r\n";
    await ctx.onLog("stdout", line.slice(0, 9)); await ctx.onLog("stdout", line.slice(9));
    return { exitCode: 0, signal: null, timedOut: false, usage: { inputTokens: 0, outputTokens: 0 }, resultJson: { type: "result", result: "" } };
  } }) }).execute(f.hooks);
  expect(result.exitCode).toBe(0);
});
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "member-cb-executor-")); roots.push(root);
  const config = { codebuddyEntry: path.join(root, "bin/codebuddy"), codebuddyHome: path.join(root, "cb-home"), codebuddyModel: "deepseek-v4.1-flash", runtimeDir: path.join(root, "runtime"), configDir: path.join(root, "state"), defaultCwd: path.join(root, "project"), projectDirs: {} };
  await mkdir(config.defaultCwd); await mkdir(path.join(config.runtimeDir, "server/dist"), { recursive: true });
  await mkdir(path.join(root, "bin")); await writeFile(config.codebuddyEntry, "fake CLI");
  await writeFile(path.join(config.runtimeDir, "server/dist/claude-local.mjs"), "// fixture");
  const skill = path.join(config.runtimeDir, "skills/paperclip"); await mkdir(skill, { recursive: true }); await writeFile(path.join(skill, "SKILL.md"), "skill");
  const hooks: ExecutorHooks = { job: { v: 1, type: "job.start", jobId: "run", companyId: "company", agent: { id: "agent", name: "Member" }, authToken: "FAKE-RUN-SECRET", context: { paperclipTaskMarkdown: "do work", paperclipWorkspace: { cwd: "/server/work", source: "project" } }, runtime: {}, config: { maxRunSec: 60 }, runtimeTools: null, handoffMarkdown: "", codeSyncDir: "" }, serverUrl: "http://localhost:3100", signal: new AbortController().signal, log: vi.fn(), meta: vi.fn(), event: vi.fn(), usage: vi.fn(), childSpawned: vi.fn() };
  return { root, config, hooks };
}
it("uses CLI with isolated config, shared login identity, REST guidance and child-only proxy", async () => {
  const f = await setup(); let received: any;
  Object.assign(f.hooks.job.context, {
    paperclipTaskMarkdownAssignment: "assignment work",
    paperclipTaskMarkdownCompact: "compact work",
    paperclipTaskMarkdownAssignmentCompact: "compact assignment work",
  });
  const env = { USERPROFILE: f.root, HOME: f.root, PATH: process.env.PATH, APPDATA: f.root, RANDOM_SECRET: "never-inherit", HTTPS_PROXY: "http://private:password@localhost:7897" };
  const result = await createCodeBuddyExecutor(f.config, { processEnv: env, loadRuntime: async () => ({ execute: async ctx => { received = ctx; return { exitCode: 0, signal: null, timedOut: false, secretField: "discard" }; } }) }).execute(f.hooks);
  expect(result.exitCode).toBe(0); expect(result).not.toHaveProperty("secretField");
  expect(received.config).toMatchObject({ engine: "cli", managedAiConnection: true, model: "deepseek-v4.1-flash" });
  expect(received.config.command).toMatch(/codebuddy\.cmd$/); expect(received.context.runtimeToolDelivery).toBe("environment");
  expect(received.context.paperclipTaskMarkdown).toContain(path.join(f.config.codebuddyHome, "skills/paperclip/SKILL.md"));
  for (const carrier of ["paperclipTaskMarkdown", "paperclipTaskMarkdownAssignment", "paperclipTaskMarkdownCompact", "paperclipTaskMarkdownAssignmentCompact"]) {
    expect(received.context[carrier]).toContain("[Text.Encoding]::UTF8.GetBytes($json)");
    expect(received.context[carrier]).toContain("-ContentType 'application/json; charset=utf-8'");
  }
  expect(received.config.env.CODEBUDDY_CONFIG_DIR).toBe(f.config.codebuddyHome);
  expect(received.config.env).not.toHaveProperty("USERPROFILE"); expect(received.config.env).not.toHaveProperty("HOME");
  expect(received.config.env.NO_PROXY).toContain("localhost"); expect(env).not.toHaveProperty("RANDOM_SECRET");
  expect(JSON.stringify(vi.mocked(f.hooks.log).mock.calls)).not.toContain("password");
});
it("prepends UTF-8 guidance to all four existing non-empty Markdown carriers", async () => {
  const f = await setup();
  const carriers = {
    paperclipTaskMarkdown: "task work",
    paperclipTaskMarkdownAssignment: "assignment work",
    paperclipTaskMarkdownCompact: "compact work",
    paperclipTaskMarkdownAssignmentCompact: "compact assignment work",
  };
  Object.assign(f.hooks.job.context, carriers);
  let received: any;
  const result = await createCodeBuddyExecutor(f.config, { processEnv: {}, queryRegistry: async () => "", loadRuntime: async () => ({ execute: async ctx => {
    received = ctx; return { exitCode: 0, signal: null, timedOut: false };
  } }) }).execute(f.hooks);
  expect(result.exitCode).toBe(0);
  for (const [key, text] of Object.entries(carriers)) {
    expect(received.context[key]).toMatch(/^Windows PowerShell 5\.1/);
    expect(received.context[key]).toContain("[Text.Encoding]::UTF8.GetBytes($json)");
    expect(received.context[key]).toContain("-ContentType 'application/json; charset=utf-8'");
    expect(received.context[key]).toContain(text);
    expect(received.context[key]).not.toContain("undefined");
  }
});
it("fills all four Markdown carriers with UTF-8 guidance, REST guidance and fallback task text", async () => {
  const f = await setup(); let received: any;
  const result = await createCodeBuddyExecutor(f.config, { processEnv: {}, queryRegistry: async () => "", loadRuntime: async () => ({ execute: async ctx => {
    received = ctx; return { exitCode: 0, signal: null, timedOut: false };
  } }) }).execute(f.hooks);
  expect(result.exitCode).toBe(0);
  for (const key of ["paperclipTaskMarkdown", "paperclipTaskMarkdownAssignment", "paperclipTaskMarkdownCompact", "paperclipTaskMarkdownAssignmentCompact"]) {
    expect(received.context).toHaveProperty(key);
    expect(typeof received.context[key]).toBe("string");
    expect(received.context[key]).toMatch(/^Windows PowerShell 5\.1/);
    expect(received.context[key]).toContain("[Text.Encoding]::UTF8.GetBytes($json)");
    expect(received.context[key]).toContain("-ContentType 'application/json; charset=utf-8'");
    expect(received.context[key]).toContain("## 成员运行的 Paperclip 操作方式");
    expect(received.context[key]).toContain("Invoke-RestMethod");
    expect(received.context[key]).toContain("do work");
    expect(received.context[key]).not.toContain("undefined");
  }
  expect(JSON.stringify(received.context)).not.toContain("undefined");
});
it.each(["", "   ", null, undefined, 0, false, {}])("fills empty or non-string Markdown carriers with UTF-8 and REST guidance: %j", async value => {
  const f = await setup(); let received: any;
  const keys = ["paperclipTaskMarkdown", "paperclipTaskMarkdownAssignment", "paperclipTaskMarkdownCompact", "paperclipTaskMarkdownAssignmentCompact"];
  for (const key of keys) f.hooks.job.context[key] = value;
  const result = await createCodeBuddyExecutor(f.config, { processEnv: {}, queryRegistry: async () => "", loadRuntime: async () => ({ execute: async ctx => {
    received = ctx; return { exitCode: 0, signal: null, timedOut: false };
  } }) }).execute(f.hooks);
  expect(result.exitCode).toBe(0);
  for (const key of keys) {
    expect(received.context).toHaveProperty(key);
    expect(typeof received.context[key]).toBe("string");
    expect(received.context[key]).toMatch(/^Windows PowerShell 5\.1/);
    expect(received.context[key]).toContain("## 成员运行的 Paperclip 操作方式");
    expect(received.context[key]).not.toContain("undefined");
  }
});
it.each([
  ["Authentication required. Please use /login command to sign in to your account", "member_agent_codebuddy_login_required", "start.ps1 -Mode login"],
  ["400 model [missing-model] service info not found", "member_agent_configuration_error", "codebuddyModel"],
  ["some other failure", "member_agent_codebuddy_failed", "some other failure"],
])("fails a zero-exit terminal error: %s", (message, code, hint) => {
  const result = normalizeCodeBuddyResult({ exitCode: 0, signal: null, timedOut: false, resultJson: { type: "result", is_error: true, subtype: "error_during_execution", errors: [message] } }, "missing-model");
  expect(result.exitCode).toBe(1); expect(result.errorCode).toBe(code); expect(result.errorMessage).toContain(hint);
  expect(() => validateResult(result)).not.toThrow();
});
it("pins final result session over a duplicate init and preserves existing Claude failure classes", () => {
  const result = normalizeCodeBuddyResult({ exitCode: 0, signal: null, timedOut: false, sessionId: "trailing-init", sessionParams: { sessionId: "trailing-init", cwd: "local" }, errorCode: "provider_quota", resultJson: { type: "result", session_id: "final-session", is_error: true } }, "");
  expect(result).toMatchObject({ exitCode: 1, sessionId: "final-session", sessionDisplayId: "final-session", sessionParams: { sessionId: "final-session", cwd: "local" }, errorCode: "provider_quota" });
});
it("returns a promise from the spawn hook required by the real runtime", async () => {
  const f = await setup();
  const result = await createCodeBuddyExecutor(f.config, { processEnv: {}, queryRegistry: async () => "", loadRuntime: async () => ({ execute: async (ctx: any) => {
    await ctx.onSpawn({ pid: 2147483000 }).catch(() => { throw new Error("spawn persistence failed"); });
    return { exitCode: 0, signal: null, timedOut: false };
  } }) }).execute(f.hooks);
  expect(result.exitCode).toBe(0);
  expect(f.hooks.childSpawned).toHaveBeenCalledWith(2147483000);
});
it("refuses to use the member's personal CodeBuddy settings directory as a project cwd", async () => {
  const f = await setup(); const personal = path.join(f.root, ".codebuddy"); await mkdir(personal);
  let loaded = false;
  const result = await createCodeBuddyExecutor({ ...f.config, defaultCwd: personal }, { processEnv: { USERPROFILE: f.root }, loadRuntime: async () => { loaded = true; throw new Error("must not load"); } }).execute(f.hooks);
  expect(result).toMatchObject({ exitCode: 1, errorCode: "member_agent_cwd_unresolved" }); expect(loaded).toBe(false);
});
it("stops after 15 minutes without output and resets the watchdog on output", async () => {
  const f = await setup();
  let ctx: any; let ready!: () => void; let complete!: (value: unknown) => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const running = createCodeBuddyExecutor(f.config, { processEnv: {}, queryRegistry: async () => "", loadRuntime: async () => ({ execute: async value => {
    ctx = value; ready(); return new Promise(resolve => { complete = resolve; });
  } }) }).execute(f.hooks);
  await started;
  vi.useFakeTimers();
  try {
    await ctx.onLog("stdout", "still working\n");
    await vi.advanceTimersByTimeAsync(14 * 60_000);
    await ctx.onLog("stdout", "progress\n");
    await vi.advanceTimersByTimeAsync(14 * 60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    complete({ exitCode: 0, signal: null, timedOut: false });
    expect(await running).toMatchObject({ timedOut: true, errorCode: "member_agent_timeout", exitCode: 1 });
  } finally { vi.useRealTimers(); }
});
it.each([false, true])("returns one normal-stop result when server cancellation and idle timeout overlap (server first=%s)", async serverFirst => {
  const f = await setup(); const controller = new AbortController();
  let ctx: any; let ready!: () => void; let complete!: (value: unknown) => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const running = createCodeBuddyExecutor(f.config, { processEnv: {}, queryRegistry: async () => "", loadRuntime: async () => ({ execute: async value => {
    ctx = value; ready(); return new Promise(resolve => { complete = resolve; });
  } }) }).execute({ ...f.hooks, signal: controller.signal });
  await started; vi.useFakeTimers();
  try {
    await ctx.onLog("stdout", "running\n");
    if (serverFirst) controller.abort();
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    if (!serverFirst) controller.abort();
    complete({ exitCode: 0, signal: null, timedOut: false });
    const result = await running;
    expect(result).toMatchObject({ exitCode: 1, timedOut: true, errorCode: "member_agent_timeout" });
    expect(() => validateResult(result)).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
