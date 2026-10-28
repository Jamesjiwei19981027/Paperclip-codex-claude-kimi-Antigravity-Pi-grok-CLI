import { once } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { connectLoop } from "../src/connection.ts";
import { AGENT_VERSION } from "../src/executors/echo.ts";
import { JobRunner } from "../src/job-runner.ts";
import { Logger } from "../src/logger.ts";
import { validateResult, type Frame, type JobStart } from "../src/protocol.ts";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2500;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for isolated version-gate fixture");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function fixture(current: string, required: unknown, codexVersion = "0.160.0", check = false) {
  const dir = mkdtempSync(join(tmpdir(), "member-agent-version-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const visible: string[] = [];
  const logger = new Logger(dir, ["FAKE-version-key"], line => visible.push(line));
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  const frames: Frame[] = [];
  let peer: import("ws").WebSocket | undefined;
  wss.on("connection", socket => {
    peer = socket;
    socket.on("message", raw => {
      const frame = JSON.parse(raw.toString()) as Frame;
      frames.push(frame);
      if (frame.type === "hello") socket.send(JSON.stringify({
        v: 1, type: "hello.ack", pinnedCodexVersion: "0.160.0", heartbeatSec: 0.02,
        ...(required === undefined ? {} : { minimumAgentVersion: required }),
      }));
    });
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Loopback fixture did not bind");
  const url = `http://127.0.0.1:${address.port}`;
  cleanup.push(() => new Promise<void>(resolve => {
    for (const socket of wss.clients) socket.terminate();
    wss.close(() => http.close(() => resolve()));
  }));
  const runner = new JobRunner({ serverUrl: url, logger, send: () => {}, executorUrl: new URL("./fixtures/executor.ts", import.meta.url) });
  const abort = new AbortController();
  let dispatched = 0;
  const running = connectLoop({ serverUrl: url, agentKey: "FAKE-version-key", version: current, codexVersion,
    signal: abort.signal, logger, check, onSession: send => runner.setSender(send),
    onFrame: frame => { dispatched++; runner.start(frame as unknown as JobStart); }, onDisconnect: () => runner.disconnect(),
  });
  cleanup.push(async () => { abort.abort(); await running; await runner.shutdown(); });
  if (check) await running;
  else await until(() => frames.some(frame => frame.type === "heartbeat"));
  return {
    frames, visible, runner, running, dispatched: () => dispatched,
    online: () => peer?.readyState === 1,
    logs: () => readdirSync(dir).map(file => readFileSync(join(dir, file), "utf8")).join("\n"),
    send(jobId: string) {
      const job: JobStart = { v: 1, type: "job.start", jobId, companyId: "fixture-company", agent: { id: "fixture-agent", name: "fixture" },
        authToken: "FAKE-version-run-token", context: {}, config: { maxRunSec: 5 }, runtime: {}, runtimeTools: null, handoffMarkdown: "", codeSyncDir: "" };
      peer!.send(JSON.stringify(job));
    },
  };
}

describe("member-agent minimum version gate", () => {
  it("keeps package and lockfile release metadata aligned with the reported 0.2.1 agent", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
    expect(pkg.version).toBe("0.2.1");
    expect(lock.version).toBe("0.2.1");
    expect(lock.packages[""].version).toBe("0.2.1");
    expect(AGENT_VERSION).toBe("0.2.1");
  });

  it("reports an outdated version as a failed one-shot self-check", async () => {
    const f = await fixture("0.1.0", "0.2.0", "0.160.0", true);
    expect(await f.running).toBe(2);
    expect(f.visible.join("\n")).toContain("请运行新安装包升级");
  });

  it("refuses every outdated job before acceptance or Worker creation while keeping heartbeats online", async () => {
    const f = await fixture(AGENT_VERSION, "0.3.0");
    f.send("old-first"); f.send("old-second");
    await until(() => f.frames.filter(frame => frame.type === "job.result").length === 2);
    expect(f.dispatched()).toBe(0);
    expect(f.runner.busy).toBe(false);
    expect(f.frames.some(frame => frame.type === "job.accepted")).toBe(false);
    expect(f.frames.find(frame => frame.type === "hello")?.agentVersion).toBe("0.2.1");
    for (const frame of f.frames.filter(frame => frame.type === "job.result")) {
      const { v: _v, type: _type, jobId: _jobId, ...payload } = frame;
      expect(validateResult(payload)).toMatchObject({ exitCode: 1, signal: null, timedOut: false, errorCode: "member_agent_version_outdated" });
      expect(frame.errorMessage).toContain("0.2.1");
      expect(frame.errorMessage).toContain("0.3.0");
      expect(frame.errorMessage).toContain("请运行新安装包升级");
    }
    const before = f.frames.filter(frame => frame.type === "heartbeat").length;
    await until(() => f.frames.filter(frame => frame.type === "heartbeat").length >= before + 2);
    expect(f.online()).toBe(true);
    expect(f.visible.join("\n")).toContain("请运行新安装包升级");
    expect(f.logs()).toContain("请运行新安装包升级");
  });

  it.each([
    ["0.2.1", "0.2.0"], ["0.2.0", "0.2.0"], ["0.3.0", "0.2.0"], ["0.10.0", "0.2.0"],
    ["1.0.0", "0.99.0"], ["0.3.0-beta.1", "0.2.0"], ["0.2.0+build.7", "0.2.0"],
    ["0.2.0-beta.10", "0.2.0-beta.2"], ["0.1", undefined],
  ])("dispatches current %s against compatible/legacy requirement %s normally", async (current, required) => {
    const f = await fixture(current, required);
    f.send("accepted-job");
    await until(() => f.frames.some(frame => frame.type === "job.result"));
    expect(f.dispatched()).toBe(1);
    expect(f.frames.find(frame => frame.type === "job.accepted")?.jobId).toBe("accepted-job");
    expect(f.frames.find(frame => frame.type === "job.result")).toMatchObject({ jobId: "accepted-job", exitCode: 0 });
  });

  it.each([
    ["0.2.0-beta.1", "0.2.0"], ["0.2.0", "0.10.0"], ["0.2.0", "broken"],
    ["0.2.0", null], ["0.2.0", 2], ["0.2.0", "00.2.0"], ["0.2.0", "9007199254740992.0.0"],
    ["0.2.0", "0.2.0-beta.01"], ["0.2.0", "0.2.0\n"], ["broken", "0.2.0"],
  ])("fails closed for current %s and unmet or malformed requirement %s", async (current, required) => {
    const f = await fixture(current, required);
    f.send("refused-job");
    await until(() => f.frames.some(frame => frame.type === "job.result"));
    expect(f.frames.find(frame => frame.type === "job.result")).toMatchObject({ errorCode: "member_agent_version_outdated", exitCode: 1 });
    expect(f.dispatched()).toBe(0);
    expect(f.online()).toBe(true);
  });

  it("retains the independent Codex version error when the member version is compatible", async () => {
    const f = await fixture("0.2.0", "0.2.0", "0.161.0");
    f.send("codex-unsupported-job");
    await until(() => f.frames.some(frame => frame.type === "job.result"));
    expect(f.frames.find(frame => frame.type === "job.result")).toMatchObject({ errorCode: "member_agent_codex_version_unsupported" });
    expect(f.dispatched()).toBe(0);
  });
});
