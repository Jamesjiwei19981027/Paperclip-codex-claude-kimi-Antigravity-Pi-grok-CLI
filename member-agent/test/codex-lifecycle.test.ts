import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobRunner } from "../src/job-runner.ts";
import { Logger } from "../src/logger.ts";
import { terminateProcessTree } from "../src/process-tree.ts";
import type { JobStart } from "../src/protocol.ts";

const dirs: string[] = [];
const runners: JobRunner[] = [];
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.shutdown();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("等待任务生命周期测试超时");
    await pause(10);
  }
}
function job(id: string, mode: "normal" | "wait" | "block", pids: number[] = [], invalidMetadata = false, maxRunSec = 5, spawnTree = false): JobStart {
  return {
    v: 1, type: "job.start", jobId: id, companyId: "fixture-company",
    agent: { id: "fixture-agent", name: "Fixture" }, authToken: "FAKE-RUN-TOKEN-ONLY-FOR-TESTS",
    context: { lifecycleFixture: { mode, pids, invalidMetadata, spawnTree } }, config: { maxRunSec }, runtime: {},
    runtimeTools: null, handoffMarkdown: "", codeSyncDir: "",
  };
}
function setup(options: { terminateTree?: (pid: number) => Promise<void>; mode?: "normal" | "wait" | "block"; pids?: number[]; invalidMetadata?: boolean; maxRunSec?: number; spawnTree?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "member-codex-lifecycle-")); dirs.push(dir);
  const frames: Record<string, unknown>[] = [];
  const visible: string[] = [];
  const logger = new Logger(dir, ["FAKE-AGENT-KEY-ONLY-FOR-TESTS"], (message) => visible.push(message));
  const runner = new JobRunner({
    serverUrl: "http://127.0.0.1:1", logger, send: (frame) => frames.push(frame),
    executorUrl: new URL("./fixtures/lifecycle-executor.ts", import.meta.url),
    ...(options.terminateTree ? { terminateTree: options.terminateTree } : {}),
  });
  runners.push(runner);
  runner.start(job("lifecycle-job", options.mode ?? "normal", options.pids ?? [], options.invalidMetadata ?? false, options.maxRunSec ?? 5, options.spawnTree ?? false));
  return { runner, frames, visible, dir };
}
const framesOf = (frames: Record<string, unknown>[], type: string) => frames.filter((frame) => frame.type === type);
function localLog(dir: string): string { return readdirSync(dir).filter(name => name.endsWith(".log")).map(name => readFileSync(join(dir, name), "utf8")).join(""); }
function treePids(frames: Record<string, unknown>[]): [number, number] | null {
  const text = framesOf(frames, "job.log").map(frame => typeof frame.chunk === "string" ? frame.chunk : "").join("");
  const match = /TREE:(\d+):(\d+)/.exec(text);
  return match ? [Number(match[1]), Number(match[2])] : null;
}
function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

describe("阶段3 job-runner 钩子与进程树收尾", () => {
  it("把有效 meta 和 usage 分别转成严格协议帧", async () => {
    const { frames } = setup();
    await until(() => framesOf(frames, "job.result").length === 1);
    expect(framesOf(frames, "job.meta")).toHaveLength(1);
    expect(framesOf(frames, "job.meta")[0]).toMatchObject({ meta: { adapterType: "codex_local", command: "fake.exe" } });
    expect(framesOf(frames, "job.usage")).toHaveLength(1);
    expect(framesOf(frames, "job.usage")[0]).toMatchObject({ usage: { complete: true, usage: { inputTokens: 1, outputTokens: 2 } } });
  });

  it("丢弃无效 meta/usage、计数并继续成功完成任务", async () => {
    const { frames, dir } = setup({ invalidMetadata: true });
    await until(() => framesOf(frames, "job.result").length === 1);
    expect(framesOf(frames, "job.meta")).toHaveLength(0);
    expect(framesOf(frames, "job.usage")).toHaveLength(0);
    expect(framesOf(frames, "job.result")[0]).toMatchObject({ exitCode: 0 });
    expect(localLog(dir)).toContain("已丢弃 2 条无效 meta/usage");
  });

  it("正整数 PID 去重登记，最多保留 64 个，超额告警", async () => {
    const killed: number[] = [];
    const { dir } = setup({ pids: Array.from({ length: 65 }, (_, index) => index + 1000), terminateTree: async (pid) => { killed.push(pid); } });
    await until(() => killed.length === 64);
    expect(killed).toHaveLength(64);
    expect(localLog(dir)).toContain("登记的子进程超过 64 个");
  });

  it.each([
    ["normal", "normal"], ["cancel", "wait"], ["timeout", "wait"], ["disconnect", "wait"], ["Ctrl+C shutdown", "wait"], ["force", "block"],
  ] as const)("%s 路径清理所有已登记进程", async (path, mode) => {
    const killed: number[] = [];
    const { runner, frames } = setup({ mode, pids: [43121], maxRunSec: path === "timeout" ? 0.05 : 5, terminateTree: async (pid) => { killed.push(pid); } });
    if (path !== "normal" && path !== "timeout") await until(() => (runner as any).active?.childPids.has(43121));
    if (path === "cancel") await runner.cancel("lifecycle-job", 0.05);
    else if (path === "timeout") await until(() => framesOf(frames, "job.result").length === 1);
    else if (path === "disconnect") await runner.disconnect(0.1);
    else if (path === "Ctrl+C shutdown") await runner.shutdown();
    else if (path === "force") await runner.force();
    else await until(() => framesOf(frames, "job.result").length === 1);
    await until(() => !runner.busy);
    expect(killed).toContain(43121);
    if (path !== "disconnect" && path !== "force") expect(framesOf(frames, "job.result")).toHaveLength(1);
    if (path === "disconnect" || path === "force") expect(framesOf(frames, "job.result")).toHaveLength(0);
  });

  it("并发清理登记的进程树；其中 taskkill 失败时汇总错误且不伪报成功", async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const started: number[] = [];
    const { frames, dir } = setup({ pids: [77881, 77882], terminateTree: async (pid) => { started.push(pid); await barrier; if (pid === 77882) throw new Error("fixture failure"); } });
    await until(() => started.length === 2);
    expect(started.sort()).toEqual([77881, 77882]);
    release();
    await until(() => framesOf(frames, "job.result").length === 1);
    expect(framesOf(frames, "job.result")[0]).toMatchObject({ exitCode: 1, errorCode: "member_agent_process_tree_termination_failed" });
    expect(framesOf(frames, "job.result")[0]?.errorMessage).toContain("77882");
    expect(localLog(dir)).toContain("无法终止进程树 77882");
  });

  it.skipIf(process.platform !== "win32").each([
    ["normal", "normal"], ["cancel", "wait"], ["timeout", "wait"], ["disconnect", "wait"], ["Ctrl+C shutdown", "wait"], ["force", "block"],
  ] as const)("Windows 实际进程树：%s 后孙进程也已退出", async (path, mode) => {
    const { runner, frames } = setup({ mode, maxRunSec: path === "timeout" ? 0.2 : 5, spawnTree: true });
    let pids: [number, number] | null = null;
    try {
      await until(() => (pids = treePids(frames)) !== null);
      if (path === "cancel") await runner.cancel("lifecycle-job", 0.1);
      else if (path === "timeout") await until(() => framesOf(frames, "job.result").length === 1);
      else if (path === "disconnect") await runner.disconnect(0.1);
      else if (path === "Ctrl+C shutdown") await runner.shutdown();
      else if (path === "force") await runner.force();
      else await until(() => framesOf(frames, "job.result").length === 1);
      await until(() => !runner.busy);
      const [childPid, grandchildPid] = pids!;
      await until(() => !processExists(childPid) && !processExists(grandchildPid));
      expect(processExists(childPid)).toBe(false);
      expect(processExists(grandchildPid)).toBe(false);
    } finally {
      if (pids?.[0] && processExists(pids[0])) await terminateProcessTree(pids[0]).catch(() => {});
    }
  }, 20_000);
});
