import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { expect, it } from "vitest";
import { connectLoop } from "../src/connection.ts";

it("keeps mandatory codexVersion none and sends optional executor metadata without applying the Codex pin", async () => {
  const http = createServer(); const wss = new WebSocketServer({ server: http });
  let hello: any;
  wss.on("connection", socket => socket.on("message", raw => {
    hello = JSON.parse(raw.toString());
    socket.send(JSON.stringify({ v: 1, type: "hello.ack", pinnedCodexVersion: "unrelated-pin", minimumAgentVersion: "0.2.0" }));
  }));
  http.listen(0, "127.0.0.1"); await once(http, "listening");
  try {
    const code = await connectLoop({ serverUrl: `http://127.0.0.1:${(http.address() as any).port}`, agentKey: "FAKE-only", version: "0.3.4", codexVersion: "none", executor: "codebuddy", executorVersion: "2.169.0", check: true, logger: { write: () => {} } });
    expect(code).toBe(0);
    expect(hello).toMatchObject({ v: 1, type: "hello", codexVersion: "none", executor: "codebuddy", executorVersion: "2.169.0", agentVersion: "0.3.4" });
  } finally { for (const socket of wss.clients) socket.terminate(); await new Promise<void>(resolve => wss.close(() => http.close(() => resolve()))); }
});
