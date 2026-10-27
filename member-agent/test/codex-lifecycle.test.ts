import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobRunner } from "../src/job-runner.ts";
import { Logger } from "../src/logger.ts";
import { ProcessTreeTracker, terminateProcessTree, terminateRecordedProcess } from "../src/process-tree.ts";
import type { ProcessRow } from "../src/process-tree.ts";
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
function setup(options: { terminateTree?: (pid: number) => Promise<void>; mode?: "normal" | "wait" | "block"; pids?: number[]; invalidMetadata?: boolean; maxRunSec?: number; spawnTree?: boolean; queryProcesses?: () => Promise<ProcessRow[]>; processSnapshotIntervalMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "member-codex-lifecycle-")); dirs.push(dir);
  const frames: Record<string, unknown>[] = [];
  const visible: string[] = [];
  const logger = new Logger(dir, ["FAKE-AGENT-KEY-ONLY-FOR-TESTS"], (message) => visible.push(message));
  const runner = new JobRunner({
    serverUrl: "http://127.0.0.1:1", logger, send: (frame) => frames.push(frame),
    executorUrl: new URL("./fixtures/lifecycle-executor.ts", import.meta.url),
    ...(options.terminateTree ? { terminateTree: options.terminateTree } : {}),
    ...(options.queryProcesses ? { queryProcesses: options.queryProcesses } : options.terminateTree ? { queryProcesses: async () => [] } : {}),
    processSnapshotIntervalMs: options.processSnapshotIntervalMs,
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
  it.skipIf(process.platform !== "win32")("still completes a successful task after the sampler exhausts three restarts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "member-sampler-exhaustion-")); dirs.push(dir);
    const completion = join(dir, "finish");
    const frames: Record<string, unknown>[] = [];
    const visible: string[] = [];
    const runner = new JobRunner({ serverUrl: "http://127.0.0.1:1", logger: new Logger(dir, [], message => visible.push(message)), send: frame => frames.push(frame),
      executorUrl: new URL("./fixtures/lifecycle-executor.ts", import.meta.url), processSnapshotIntervalMs: 100, processSnapshotRestartDelayMs: 10,
    });
    runners.push(runner);
    const task = job("sampler-exhaustion", "normal", [], false, 20, true);
    (task.context.lifecycleFixture as Record<string, unknown>).completionPath = completion;
    runner.start(task);
    await until(() => treePids(frames) !== null);
    const tracker = (runner as any).active.processTracker as ProcessTreeTracker;
    for (let launch = 0; launch < 4; launch++) {
      await until(() => tracker.queryProcessPid !== null && tracker.identities().length > 0);
      const pid = tracker.queryProcessPid!;
      process.kill(pid);
      await until(() => tracker.queryProcessPid !== pid);
    }
    expect(tracker.queryProcessPid).toBeNull();
    writeFileSync(completion, "finish");
    await until(() => framesOf(frames, "job.result").length === 1);
    expect(framesOf(frames, "job.result")[0]).toMatchObject({ exitCode: 0 });
    expect(localLog(dir).match(/快照查询失败/g)).toHaveLength(1);
  });

  it("snapshot query failures only warn and do not fail a successful task", async () => {
    const { frames, dir } = setup({ pids: [45123], terminateTree: async () => {}, queryProcesses: async () => { throw new Error("FAKE snapshot failure"); } });
    await until(() => framesOf(frames, "job.result").length === 1);
    expect(framesOf(frames, "job.result")[0]).toMatchObject({ exitCode: 0 });
    expect(localLog(dir)).toContain("快照查询失败");
  });

  it.skipIf(process.platform !== "win32")("does not terminate a live PID whose creation time differs from the snapshot", async () => {
    const child = fork(fileURLToPath(new URL("./fixtures/process-tree.mjs", import.meta.url)), ["grandchild"], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const tracker = new ProcessTreeTracker({ warn: () => {} });
    try {
      await new Promise<void>((resolve, reject) => { child.once("message", () => resolve()); child.once("error", reject); });
      tracker.track(child.pid!);
      await until(() => tracker.identities().some(identity => identity.pid === child.pid));
      const identity = (await tracker.stop()).find(identity => identity.pid === child.pid)!;
      const mismatch = { ...identity, creationTime: (BigInt(identity.creationTime) + 10n).toString() };
      expect(await terminateRecordedProcess(mismatch)).toBe(false);
      expect(processExists(child.pid!)).toBe(true);
      expect(await terminateRecordedProcess(identity)).toBe(true);
      expect(processExists(child.pid!)).toBe(false);
    } finally {
      await tracker.stop();
      if (child.pid && processExists(child.pid)) await terminateProcessTree(child.pid);
    }
  });

  it.skipIf(process.platform !== "win32")("cleans a recorded grandchild after its parent exits first", async () => {
    const dir = mkdtempSync(join(tmpdir(), "member-orphan-lifecycle-")); dirs.push(dir);
    const release = join(dir, "release-parent");
    const frames: Record<string, unknown>[] = [];
    const runner = new JobRunner({
      serverUrl: "http://127.0.0.1:1", logger: new Logger(dir, [], () => {}), send: frame => frames.push(frame),
      executorUrl: new URL("./fixtures/lifecycle-executor.ts", import.meta.url), processSnapshotIntervalMs: 50,
    });
    runners.push(runner);
    const task = job("orphan-job", "wait", [], false, 20, true);
    (task.context.lifecycleFixture as Record<string, unknown>).orphanReleasePath = release;
    runner.start(task);
    let pids: [number, number] | null = null;
    try {
      await until(() => (pids = treePids(frames)) !== null);
      // Release the parent only once a real Windows snapshot has recorded its grandchild.
      await until(() => (runner as any).active?.processTracker.identities().some((identity: { pid: number }) => identity.pid === pids![1]));
      writeFileSync(release, "release");
      await until(() => !processExists(pids![0]));
      expect(processExists(pids![1])).toBe(true);
      await runner.cancel("orphan-job", 0.1);
      expect(processExists(pids![1])).toBe(false);
      expect(framesOf(frames, "job.result")[0]).toMatchObject({ errorCode: "cancelled" });
    } finally {
      await runner.force();
      for (const pid of pids ?? []) if (processExists(pid)) await terminateProcessTree(pid).catch(() => {});
    }
  });

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
