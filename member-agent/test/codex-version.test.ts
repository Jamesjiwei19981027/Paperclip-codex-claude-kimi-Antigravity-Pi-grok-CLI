import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { codexVersionStatus, connectLoop } from "../src/connection.ts";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); });

async function startFakeServer(pinned: string, sendJob = false): Promise<{ url: string; results: any[] }> {
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  const results: any[] = [];
  wss.on("connection", (socket) => socket.on("message", (raw) => {
    const frame = JSON.parse(raw.toString());
    if (frame.type === "hello") {
      socket.send(JSON.stringify({ v: 1, type: "hello.ack", heartbeatSec: 60, pinnedCodexVersion: pinned }));
      if (sendJob) setTimeout(() => socket.send(JSON.stringify({ v: 1, type: "job.start", jobId: "FAKE-version-job" })), 0);
    } else if (frame.type === "job.result") results.push(frame);
  }));
  http.listen(0, "127.0.0.1"); await once(http, "listening");
  const address = http.address(); if (!address || typeof address === "string") throw new Error("fake server failed to listen");
  closers.push(() => new Promise<void>((resolve) => wss.close(() => http.close(() => resolve()))));
  return { url: `http://127.0.0.1:${address.port}`, results };
}

function logger() { const lines: string[] = []; return { lines, write: (_level: string, line: string) => lines.push(line) }; }

describe("Codex version gate", () => {
  it("same supported stable version is accepted", () => expect(codexVersionStatus("0.160.0", "0.160.0")).toBe("match"));
  it("different stable versions inside the supported window are accepted with warning", () => expect(codexVersionStatus("0.159.9", "0.160.0")).toBe("compatible"));
  it.each([["0.161.0", "0.161.0"], ["0.160.0-beta.1", "0.160.0"], ["unparsed", "0.160.0"], ["0.160.0", "unknown"]])("unsupported or unparsable version %s / %s is rejected", (current, pinned) => expect(codexVersionStatus(current, pinned)).toBe("unsupported"));

  it("unsupported mismatch stays connected and returns the protocol error for each task", async () => {
    const fake = await startFakeServer("0.161.0", true); const abort = new AbortController(); const log = logger(); let dispatched = false;
    const running = connectLoop({ serverUrl: fake.url, agentKey: "FAKE-agent-key", version: "0.1", codexVersion: "0.161.0", signal: abort.signal, logger: log,
      onFrame: () => { dispatched = true; } });
    for (let i = 0; i < 100 && fake.results.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fake.results[0]).toMatchObject({ type: "job.result", errorCode: "member_agent_codex_version_unsupported" });
    expect(dispatched).toBe(false); expect(log.lines.join("\n")).toContain("不兼容");
    abort.abort(); await expect(running).resolves.toBe(0);
  });

  it("in-window mismatch warns and still dispatches", async () => {
    const fake = await startFakeServer("0.160.0", true); const abort = new AbortController(); const log = logger(); let dispatched = false;
    const running = connectLoop({ serverUrl: fake.url, agentKey: "FAKE-agent-key", version: "0.1", codexVersion: "0.159.9", signal: abort.signal, logger: log,
      onFrame: () => { dispatched = true; abort.abort(); } });
    for (let i = 0; i < 100 && !dispatched; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(dispatched).toBe(true); expect(log.lines.join("\n")).toContain("继续运行");
    await expect(running).resolves.toBe(0);
  });
});
