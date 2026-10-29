import { hostname } from "node:os";
import type { Executor, ExecutorHooks, ExecutorResult } from "./types.ts";

export const AGENT_VERSION = "0.3.4";

function cancelled(): ExecutorResult {
  return { exitCode: 1, signal: null, timedOut: false, errorCode: "cancelled", errorMessage: "echo 执行器已取消" };
}

function failure(hooks: ExecutorHooks, message: string): ExecutorResult {
  hooks.log("stderr", `${message}\n`);
  return { exitCode: 1, signal: null, timedOut: false, errorCode: "member_agent_echo_writeback_failed", errorMessage: message };
}

function hold(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return; }
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

// Test-only timing control for A5/A6. Real executors must never use echoHoldSec.
export function createEchoExecutor(options: { echoHoldSec?: number } = {}): Executor {
  const echoHoldSec = options.echoHoldSec ?? 0;
  return {
  name: "echo",
  async execute(hooks) {
    const { job, signal } = hooks;
    if (signal.aborted) return cancelled();
    hooks.log("stdout", `成员代理收到任务 ${job.jobId}\n`);
    if (echoHoldSec > 0) await hold(echoHoldSec * 1000, signal);
    if (signal.aborted) return cancelled();
    const issueId = typeof job.context.issueId === "string" && job.context.issueId
      ? job.context.issueId : typeof job.context.taskId === "string" ? job.context.taskId : "";
    if (issueId) {
      const endpoint = `${hooks.serverUrl.replace(/\/+$/, "")}/api/issues/${encodeURIComponent(issueId)}`;
      const headers = { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${job.authToken}`, "x-paperclip-run-id": job.jobId };
      const comment = `连接测试：成员代理 echo 执行器（版本 ${AGENT_VERSION}，主机 ${hostname()}）已收到任务，并用本次运行令牌写回了这条评论。`;
      // Marking an issue done is exclusively a Phase 2 echo TEST behavior. It
      // prevents test tasks from continuing automatically; future executors
      // must follow their actual task workflow instead of copying this PATCH.
      const requests = [
        { method: "POST", url: `${endpoint}/comments`, body: { body: comment } },
        { method: "PATCH", url: endpoint, body: { status: "done", comment: "连接测试：echo 执行器已完成，本测试工单标记为完成。" } },
      ];
      for (const request of requests) {
        if (signal.aborted) return cancelled();
        try {
          const response = await fetch(request.url, { method: request.method, headers, body: JSON.stringify(request.body), signal, redirect: "error" });
          // Discard HTTP bodies: neither diagnostic text nor secrets from the
          // server may become job logs, error messages, or retained buffers.
          await response.body?.cancel();
          if (signal.aborted) return cancelled();
          if (!response.ok) return failure(hooks, `echo 写回失败：HTTP ${response.status}`);
        } catch {
          if (signal.aborted) return cancelled();
          return failure(hooks, "echo 写回失败：网络请求未完成，请检查服务器连接");
        }
      }
    }
    if (signal.aborted) return cancelled();
    return { exitCode: 0, signal: null, timedOut: false, summary: "echo 执行器完成" };
  },
  };
}

export const echoExecutor: Executor = createEchoExecutor();
