import { createHash } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import { createRequire } from "node:module";
import { BlockList, isIP } from "node:net";
import type { Duplex } from "node:stream";
import type { TLSSocket } from "node:tls";
import { and, eq } from "drizzle-orm";
import { agents, type Db } from "@paperclipai/db";
import type { DeploymentMode } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { authenticateAgentKey } from "./agent-key-auth.js";
import { minimumAgentVersion, pinnedCodexVersion } from "../adapters/member-agent/settings.js";

const require = createRequire(import.meta.url);
interface MemberSocket {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: "message", listener: (data: Buffer, binary: boolean) => void): void;
  on(event: "close" | "error", listener: () => void): void;
}
interface MemberSocketServer {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, callback: (socket: MemberSocket) => void): void;
  close(callback?: () => void): void;
  on(event: "error", listener: () => void): void;
}
const { WebSocketServer } = require("ws") as { WebSocketServer: new (options: { noServer: boolean; maxPayload: number }) => MemberSocketServer };
export const MEMBER_AGENT_MAX_FRAME_BYTES = 256 * 1024;
export const MEMBER_AGENT_HEARTBEAT_MS = 45000;
export type MemberFrame = Record<string, unknown>;
export interface MemberJob {
  id: string;
  receive(frame: MemberFrame): void;
  fail(code: string, message: string): void;
}
export interface MemberConnection {
  companyId: string;
  agentId: string;
  socket: MemberSocket;
  credential: string;
  connectedAt: number;
  lastHeartbeatAt: number;
  ready: boolean;
  currentJobId: string | null;
  job: MemberJob | null;
  disconnect(code?: string, message?: string): void;
}

/** Company is part of every lookup. Remote PIDs never enter the local process registry. */
export class MemberAgentConnections {
  private connections = new Map<string, MemberConnection>();
  private key(companyId: string, agentId: string) { return JSON.stringify([companyId, agentId]); }
  get(companyId: string, agentId: string) {
    const connection = this.connections.get(this.key(companyId, agentId));
    return connection?.ready && connection.socket.readyState === 1 ? connection : undefined;
  }
  reserve(connection: MemberConnection) {
    const key = this.key(connection.companyId, connection.agentId);
    if (this.connections.has(key)) return false;
    this.connections.set(key, connection);
    return true;
  }
  remove(connection: MemberConnection) {
    const key = this.key(connection.companyId, connection.agentId);
    if (this.connections.get(key) === connection) this.connections.delete(key);
  }
  values() { return [...this.connections.values()]; }
}
export const memberAgentConnections = new MemberAgentConnections();

const loopbackAddresses = new BlockList();
loopbackAddresses.addSubnet("127.0.0.0", 8, "ipv4");
loopbackAddresses.addAddress("::1", "ipv6");

const privateAddresses = new BlockList();
privateAddresses.addSubnet("10.0.0.0", 8, "ipv4");
// Tailscale/运营商级 NAT 地址段；按其网络自身加密的信任边界放行。
privateAddresses.addSubnet("100.64.0.0", 10, "ipv4");
privateAddresses.addSubnet("172.16.0.0", 12, "ipv4");
privateAddresses.addSubnet("192.168.0.0", 16, "ipv4");
privateAddresses.addSubnet("169.254.0.0", 16, "ipv4");
privateAddresses.addSubnet("fc00::", 7, "ipv6");
privateAddresses.addSubnet("fe80::", 10, "ipv6");

type MemberPeerCategory = "public" | "private" | "loopback";

export function isMemberAgentTransportAllowed(input: {
  encrypted: boolean;
  remoteAddress?: string;
  forwardedProto?: string | string[];
}): { allowed: boolean; category: MemberPeerCategory; reason: string | null } {
  const forwardedProto = (Array.isArray(input.forwardedProto) ? input.forwardedProto[0] : input.forwardedProto)
    ?.split(",", 1)[0]?.trim().toLowerCase();
  const rawAddress = input.remoteAddress?.trim();
  const mappedIpv4 = rawAddress?.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i)?.[1];
  const address = mappedIpv4 ?? rawAddress;
  const version = address ? isIP(address) : 0;
  const category: MemberPeerCategory = version && loopbackAddresses.check(address!, version === 4 ? "ipv4" : "ipv6")
    ? "loopback"
    : version && privateAddresses.check(address!, version === 4 ? "ipv4" : "ipv6")
      ? "private"
      : "public";

  if ((category === "loopback" || category === "private") && forwardedProto === "http") {
    return { allowed: false, category, reason: "forwarded_http" };
  }
  if (input.encrypted) return { allowed: true, category, reason: null };
  if (category === "loopback" || category === "private") return { allowed: true, category, reason: null };
  return { allowed: false, category, reason: rawAddress ? "public_cleartext" : "missing_peer_address" };
}

export function assertMemberAgentJwtTtl(env: NodeJS.ProcessEnv = process.env) {
  const configured = Number(env.PAPERCLIP_AGENT_JWT_TTL_SECONDS);
  const ttl = Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 48 * 3600;
  if (ttl < 8 * 3600) throw new Error("member_agent requires a run-token lifetime of at least 8 hours");
}

export function setupMemberAgentWebSocketServer(server: Server, db: Db, options: {
  deploymentMode: DeploymentMode;
  connections?: MemberAgentConnections;
}) {
  const connections = options.connections ?? memberAgentConnections;
  const owned = new Set<MemberConnection>();
  if (options.deploymentMode !== "authenticated") {
    logger.info("member_agent WebSocket disabled: authenticated deployment is required");
    return { close: async () => {}, sweep: (_now: number) => {} };
  }
  assertMemberAgentJwtTtl();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MEMBER_AGENT_MAX_FRAME_BYTES });
  wss.on("error", () => logger.warn("member_agent WebSocket server error"));
  const failures = new Map<string, { count: number; until: number }>();
  let stopped = false;
  const reject = (socket: Duplex, status = "401 Unauthorized") => {
    if (!socket.destroyed && socket.writable) socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };
  const upgrade = (req: IncomingMessage & { paperclipWebSocketHandled?: boolean }, socket: Duplex, head: Buffer) => {
    if (req.paperclipWebSocketHandled || !req.url) return;
    let pathname: string;
    try { pathname = new URL(req.url, "http://localhost").pathname; } catch { return; }
    if (pathname !== "/api/member-agent/v1/connect") return;
    // The existing live-events handler closes unclaimed paths. Claim synchronously first.
    req.paperclipWebSocketHandled = true;
    socket.on("error", () => {});
    const transport = isMemberAgentTransportAllowed({
      encrypted: (req.socket as TLSSocket).encrypted === true,
      remoteAddress: req.socket.remoteAddress,
      forwardedProto: req.headers["x-forwarded-proto"],
    });
    if (!transport.allowed) {
      logger.warn({ reason: transport.reason, peerCategory: transport.category }, "member_agent rejected an insecure peer transport");
      reject(socket, "403 Forbidden");
      return;
    }
    const authorization = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
    let fingerprint = createHash("sha256").update(authorization || req.socket.remoteAddress || "unknown").digest("hex");
    const now = Date.now();
    for (const [key, failure] of failures) if (failure.until <= now) failures.delete(key);
    if ((failures.get(fingerprint)?.count ?? 0) >= 5) { reject(socket, "429 Too Many Requests"); return; }
    const recordFailure = () => {
      if (failures.size >= 10000 && !failures.has(fingerprint)) failures.delete(failures.keys().next().value!);
      const failure = failures.get(fingerprint) ?? { count: 0, until: Date.now() + 60000 };
      failure.count++; failures.set(fingerprint, failure);
    };
    void (async () => {
      const key = await authenticateAgentKey(db, req.headers);
      if (!key) { recordFailure(); reject(socket); return; }
      // All keys belonging to the same agent share its hello-failure budget.
      fingerprint = JSON.stringify([key.companyId, key.agentId]);
      if ((failures.get(fingerprint)?.count ?? 0) >= 5) { reject(socket, "429 Too Many Requests"); return; }
      const [agent] = await db.select({ id: agents.id, companyId: agents.companyId, status: agents.status, adapterType: agents.adapterType })
        .from(agents).where(and(eq(agents.id, key.agentId), eq(agents.companyId, key.companyId)));
      if (stopped || socket.destroyed) return;
      wss.handleUpgrade(req, socket, head, ws => {
        ws.on("error", () => {});
        let helloTimer: ReturnType<typeof setTimeout>;
        let heartbeatTimer: ReturnType<typeof setTimeout>;
        let closed = false;
        const sendReject = (code: string, message: string, countsAsFailure = true) => {
          if (countsAsFailure) recordFailure();
          ws.send(JSON.stringify({ v: 1, type: "hello.reject", code, message }));
          ws.close(1008, code);
        };
        if (!agent || ["paused", "terminated", "pending_approval"].includes(agent.status) || agent.adapterType !== "member_agent") {
          sendReject("member_agent_not_allowed", "该智能体未获准建立成员连接"); return;
        }
        const connection: MemberConnection = {
          companyId: agent.companyId, agentId: agent.id, socket: ws,
          credential: authorization.slice(7).trim(), connectedAt: Date.now(), lastHeartbeatAt: Date.now(),
          ready: false, currentJobId: null, job: null,
          disconnect(code = "member_agent_disconnected", message = "成员智能体连接已断开") {
            if (closed) return;
            closed = true;
            clearTimeout(helloTimer); clearTimeout(heartbeatTimer);
            connection.ready = false;
            connection.job?.fail(code, message);
            connection.credential = "";
            connections.remove(connection); owned.delete(connection);
            if (ws.readyState === 1 || ws.readyState === 0) ws.terminate();
          },
        };
        if (!connections.reserve(connection)) { sendReject("already_connected", "该智能体已经建立连接", false); return; }
        owned.add(connection);
        const touch = () => {
          connection.lastHeartbeatAt = Date.now(); clearTimeout(heartbeatTimer);
          heartbeatTimer = setTimeout(() => connection.disconnect(), MEMBER_AGENT_HEARTBEAT_MS);
          heartbeatTimer.unref();
        };
        helloTimer = setTimeout(() => { recordFailure(); connection.disconnect("member_agent_protocol_error", "成员连接未在十秒内发送 hello"); }, 10000);
        helloTimer.unref();
        ws.on("close", () => connection.disconnect());
        ws.on("error", () => connection.disconnect());
        ws.on("message", (bytes, binary) => {
          if (closed) return;
          let frame: MemberFrame;
          try {
            if (binary || bytes.length > MEMBER_AGENT_MAX_FRAME_BYTES) throw new Error();
            const value: unknown = JSON.parse(bytes.toString("utf8"));
            if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
            frame = value as MemberFrame;
            if (frame.v !== 1 || typeof frame.type !== "string") throw new Error();
          } catch { recordFailure(); connection.disconnect("member_agent_protocol_error", "成员连接消息格式或版本无效"); return; }
          touch();
          if (frame.type === "hello") {
            if (connection.ready || !["agentVersion", "codexVersion", "hostname"].every(key => typeof frame[key] === "string" && (frame[key] as string).length > 0 && (frame[key] as string).length <= 255)
              || !["win32", "darwin", "linux"].includes(String(frame.platform))) {
              recordFailure(); connection.disconnect("member_agent_protocol_error", "成员连接 hello 无效"); return;
            }
            clearTimeout(helloTimer); connection.ready = true;
            ws.send(JSON.stringify({ v: 1, type: "hello.ack", heartbeatSec: 15, maxRunSec: 3600, pinnedCodexVersion, minimumAgentVersion }));
            return;
          }
          if (frame.type === "heartbeat" || frame.type === "ping") return;
          if (["job.accepted", "job.log", "job.meta", "job.event", "job.usage", "job.result"].includes(frame.type as string)) {
            if (!connection.ready) { connection.disconnect("member_agent_protocol_error", "必须先发送 hello"); return; }
            // A stale/foreign job is never allowed to select another run's callbacks.
            if (frame.jobId !== connection.currentJobId || !connection.job) return;
            connection.job.receive(frame); return;
          }
          logger.warn({ companyId: connection.companyId, agentId: connection.agentId }, "member_agent ignored an unknown message type");
        });
      });
    })().catch(() => { recordFailure(); reject(socket, "500 Internal Server Error"); });
  };
  server.prependListener("upgrade", upgrade);
  const sweep = (now: number) => {
    for (const connection of owned) if (now - connection.lastHeartbeatAt >= MEMBER_AGENT_HEARTBEAT_MS) connection.disconnect();
  };
  const close = async () => {
    if (stopped) return;
    stopped = true; server.off("upgrade", upgrade);
    for (const connection of [...owned]) connection.disconnect();
    await new Promise<void>(resolve => wss.close(resolve));
  };
  server.once("close", () => { void close(); });
  return { close, sweep };
}
