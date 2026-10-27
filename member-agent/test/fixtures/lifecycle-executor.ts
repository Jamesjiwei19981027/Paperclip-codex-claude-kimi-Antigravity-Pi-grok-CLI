import type { Executor, ExecutorHooks, ExecutorResult } from "../../src/executors/types.ts";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const success: ExecutorResult = { exitCode: 0, signal: null, timedOut: false };

const executor: Executor = {
  name: "lifecycle-fixture",
  async execute(hooks: ExecutorHooks): Promise<ExecutorResult> {
    const fixture = hooks.job.context.lifecycleFixture as {
      mode?: string;
      pids?: number[];
      invalidMetadata?: boolean;
      spawnTree?: boolean;
      orphanReleasePath?: string;
      completionPath?: string;
    } | undefined;
    for (const pid of fixture?.pids ?? []) hooks.childSpawned(pid);
    hooks.meta(fixture?.invalidMetadata
      ? { adapterType: "codex_local", command: "fake.exe", unexpected: true }
      : { adapterType: "codex_local", command: "fake.exe", commandArgs: [], promptMetrics: {} });
    hooks.usage(fixture?.invalidMetadata
      ? { complete: true, unexpected: true }
      : { complete: true, usage: { inputTokens: 1, outputTokens: 2 }, provider: "openai", billingType: "subscription" });
    if (fixture?.spawnTree) {
      const child = fork(fileURLToPath(new URL("./process-tree.mjs", import.meta.url)), fixture.orphanReleasePath ? [fixture.orphanReleasePath] : [], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
      if (!child.pid) throw new Error("测试子进程未启动");
      hooks.childSpawned(child.pid);
      const grandchildPid = await new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("测试孙进程未就绪")), 10_000);
        child.once("message", (message) => {
          clearTimeout(timeout);
          resolve((message as { grandchildPid: number }).grandchildPid);
        });
        child.once("error", (error) => { clearTimeout(timeout); reject(error); });
      });
      hooks.log("stdout", `TREE:${child.pid}:${grandchildPid}\n`);
    }
    if (fixture?.completionPath) {
      while (!existsSync(fixture.completionPath)) await new Promise(resolve => setTimeout(resolve, 10));
    }
    if (fixture?.mode === "wait") {
      await new Promise<void>((resolve) => {
        if (hooks.signal.aborted) return resolve();
        hooks.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return { ...success, exitCode: 1, errorCode: "cancelled" };
    }
    if (fixture?.mode === "block") await new Promise<void>(() => {});
    return success;
  },
};

export default executor;
