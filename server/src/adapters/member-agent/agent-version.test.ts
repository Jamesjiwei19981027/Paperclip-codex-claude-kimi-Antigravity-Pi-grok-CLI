import { once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { agentApiKeys, type Db } from "@paperclipai/db";
import { afterEach, describe, expect, it } from "vitest";
import { MemberAgentConnections, setupMemberAgentWebSocketServer } from "../../realtime/member-agent-ws.js";

const { WebSocket } = createRequire(import.meta.url)("ws");
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

describe("member-agent version handshake", () => {
  it("advertises the minimum version on the real loopback hello.ack while leaving old agents online", async () => {
    // In-memory query boundary only: no database, real account, or external server.
    const key = { id: "fixture-key-id", companyId: "fixture-company", agentId: "fixture-agent", scopeConfig: null };
    const agent = { id: key.agentId, companyId: key.companyId, status: "idle", adapterType: "member_agent" };
    const db = {
      select: () => ({ from: (table: unknown) => ({ where: () => Promise.resolve(table === agentApiKeys ? [key] : [agent]) }) }),
      update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
    } as unknown as Db;
    const http = createServer();
    const connections = new MemberAgentConnections();
    const transport = setupMemberAgentWebSocketServer(http, db, { deploymentMode: "authenticated", connections });
    cleanup.push(async () => { await transport.close(); await new Promise<void>(resolve => http.close(() => resolve())); });
    http.listen(0, "127.0.0.1");
    await once(http, "listening");
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("Loopback fixture did not bind");
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/member-agent/v1/connect`, { headers: { Authorization: "Bearer FAKE-version-key" } });
    cleanup.push(() => socket.terminate());
    await once(socket, "open");
    const response = once(socket, "message");
    socket.send(JSON.stringify({ v: 1, type: "hello", agentVersion: "0.1.0", codexVersion: "0.160.0", hostname: "fixture", platform: "win32" }));
    const [raw] = await response;
    expect(JSON.parse(raw.toString())).toMatchObject({ v: 1, type: "hello.ack", minimumAgentVersion: "0.2.0", pinnedCodexVersion: "0.160.0", heartbeatSec: 15 });
    expect(connections.get(key.companyId, key.agentId)?.ready).toBe(true);
    expect(socket.readyState).toBe(1);
  });
});
