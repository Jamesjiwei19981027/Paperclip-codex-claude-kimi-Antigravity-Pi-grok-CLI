import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateConfig } from "../src/config.ts";
import { createEchoExecutor, echoExecutor } from "../src/executors/echo.ts";
import type { ExecutorHooks, JobStart } from "../src/executors/types.ts";
import { JobRunner } from "../src/job-runner.ts";
import { Logger } from "../src/logger.ts";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const inputConfig = () => ({ serverUrl: "http://127.0.0.1:1", agentKey: "FAKE-HOLD-AGENT-KEY", executor: "echo", projectDirs: {}, defaultCwd: "" });
function hooks() {
  const abort = new AbortController();
  const logs: string[] = [];
  const job: JobStart = { v: 1, type: "job.start", jobId: "fake-hold-job", companyId: "fake-company", agent: { id: "fake-agent", name: "测试" }, authToken: "FAKE-HOLD-RUN-TOKEN", context: { issueId: "fake-hold-issue" }, config: {}, runtime: {}, runtimeTools: null, handoffMarkdown: "", codeSyncDir: "" };
  const value: ExecutorHooks = { job, signal: abort.signal, serverUrl: "http://127.0.0.1:1", log: (_stream, text) => logs.push(text), event() {} };
  return { abort, logs, value };
}
function mockFetch() {
  const requests: string[] = [];
  const fetch = vi.fn(async (_url: string, init: RequestInit) => { requests.push(String(init.method)); return new Response("{}", { status: 200 }); });
  vi.stubGlobal("fetch", fetch);
  return { fetch, requests };
}

describe("echoHoldSec 测试专用配置", () => {
  it("defaults to zero and preserves immediate echo writeback", async () => {
    expect(validateConfig(inputConfig(), {}).echoHoldSec).toBe(0);
    const { requests } = mockFetch();
    const result = await echoExecutor.execute(hooks().value);
    expect(result).toMatchObject({ exitCode: 0, summary: "echo 执行器完成" });
    expect(requests).toEqual(["POST", "PATCH"]);
  });
  it.each([-1, 601, 1.5, "abc"])("rejects invalid echoHoldSec %s with a Chinese field diagnostic", echoHoldSec => {
    expect(() => validateConfig({ ...inputConfig(), echoHoldSec }, {})).toThrow(/echoHoldSec.*整数.*0.*600/);
  });
  it("accepts both endpoints and still rejects unknown configuration fields", () => {
    for (const echoHoldSec of [0, 600]) expect(validateConfig({ ...inputConfig(), echoHoldSec }, {}).echoHoldSec).toBe(echoHoldSec);
    expect(() => validateConfig({ ...inputConfig(), echoHoldSecs: 2 }, {})).toThrow("echoHoldSecs");
  });
  it("cancels a 30 second hold in under one second without any writeback", async () => {
    const { fetch } = mockFetch();
    const input = hooks();
    const pending = createEchoExecutor({ echoHoldSec: 30 }).execute(input.value);
    expect(input.logs).toEqual(["成员代理收到任务 fake-hold-job\n"]);
    const started = performance.now(); input.abort.abort();
    expect(await pending).toMatchObject({ exitCode: 1, errorCode: "cancelled" });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("waits two seconds before normal writeback with an injected clock", async () => {
    vi.useFakeTimers();
    const { requests } = mockFetch();
    const pending = createEchoExecutor({ echoHoldSec: 2 }).execute(hooks().value);
    await vi.advanceTimersByTimeAsync(1999); expect(requests).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ exitCode: 0 }); expect(requests).toEqual(["POST", "PATCH"]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("passes the local hold through workerData and cancellation prevents worker writeback", async () => {
    const dir = mkdtempSync(join(tmpdir(), "member-echo-hold-"));
    const frames: Array<Record<string, unknown>> = [];
    const runner = new JobRunner({ serverUrl: "http://127.0.0.1:1", logger: new Logger(dir, ["FAKE-HOLD-AGENT-KEY"], () => {}), send: frame => frames.push(frame), echoHoldSec: 30 });
    try {
      runner.start(hooks().value.job);
      const deadline = Date.now() + 3000;
      while (!frames.some(frame => frame.type === "job.log")) { if (Date.now() > deadline) throw new Error("测试执行器未开始"); await new Promise(resolve => setTimeout(resolve, 10)); }
      expect(frames.some(frame => frame.type === "job.result")).toBe(false);
      const started = performance.now(); await runner.cancel("fake-hold-job", 1);
      expect(performance.now() - started).toBeLessThan(1000);
      expect(frames.find(frame => frame.type === "job.result")).toMatchObject({ errorCode: "cancelled" });
    } finally { await runner.shutdown(); rmSync(dir, { recursive: true, force: true }); }
  });
});
