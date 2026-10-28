import { hostname, platform } from 'node:os';
import { createRequire } from 'node:module';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { Frame } from './protocol.ts';
import { OutboundQueue } from './outbound-queue.ts';

export interface ConnectionSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string, callback: (error?: Error) => void): void;
  ping(data: string, callback: (error?: Error) => void): void;
  terminate(): void;
  on(event: 'open', callback: () => void): void;
  on(event: 'error', callback: (error: Error) => void): void;
  on(event: 'unexpected-response', callback: (request: ClientRequest, response: IncomingMessage) => void): void;
  on(event: 'close', callback: (code: number, reason: Buffer) => void): void;
  on(event: 'message', callback: (data: Buffer, binary: boolean) => void): void;
  on(event: 'pong', callback: () => void): void;
}
const { WebSocket } = createRequire(import.meta.url)('ws') as {
  WebSocket: new (url: string, options: { headers: { Authorization: string }; maxPayload: number; agent: false }) => ConnectionSocket;
};

export interface Clock {
  setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
  random(): number;
}
export interface ConnectionOptions {
  serverUrl: string;
  agentKey: string;
  version: string;
  codexVersion?: string;
  check?: boolean;
  signal?: AbortSignal;
  logger: { write(level: 'info' | 'warn' | 'error' | 'debug', message: string, visible?: boolean): void };
  onFrame?: (frame: Frame) => void | Promise<void>;
  onReady?: (ack: Frame) => void;
  onSession?: (send: (frame: Frame) => void, drain: () => Promise<boolean>) => void;
  onDisconnect?: () => Promise<void>;
  clock?: Clock;
  socketFactory?: (url: string, options: { headers: { Authorization: string }; maxPayload: number; agent: false }) => ConnectionSocket;
}
interface Outcome { exit?: number; delay?: number; ready: boolean }
const nativeClock: Clock = { setTimeout, clearTimeout, random: Math.random };

type CodexVersionStatus = "match" | "compatible" | "unsupported";
function stableVersion(value: unknown): [number, number, number] | null {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+$/.test(value)) return null;
  const parts = value.split(".").map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) return null;
  return parts as [number, number, number];
}
function inSupportedWindow(value: unknown): boolean {
  const version = stableVersion(value);
  if (!version) return false;
  const [major, minor] = version;
  return major === 0 && minor >= 149 && minor < 161;
}
export function codexVersionStatus(current: unknown, pinned: unknown): CodexVersionStatus {
  if (current === pinned && inSupportedWindow(current)) return "match";
  if (inSupportedWindow(current) && inSupportedWindow(pinned)) return "compatible";
  return "unsupported";
}

interface AgentVersion { core: number[]; prerelease: string[] }
function agentVersion(value: unknown): AgentVersion | null {
  if (typeof value !== 'string' || value.length > 255) return null;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (!match) return null;
  const core = match.slice(1, 4).map(Number);
  const prerelease = match[4]?.split('.') ?? [];
  if (core.some(part => !Number.isSafeInteger(part)) || prerelease.some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) return null;
  return { core, prerelease };
}

function meetsMinimumAgentVersion(current: unknown, minimum: unknown): boolean {
  const actual = agentVersion(current), required = agentVersion(minimum);
  if (!actual || !required) return false;
  for (let index = 0; index < 3; index++) {
    if (actual.core[index] !== required.core[index]) return actual.core[index]! > required.core[index]!;
  }
  if (!actual.prerelease.length) return true;
  if (!required.prerelease.length) return false;
  for (let index = 0; index < Math.max(actual.prerelease.length, required.prerelease.length); index++) {
    const left = actual.prerelease[index], right = required.prerelease[index];
    if (left === right) continue;
    if (left === undefined) return false;
    if (right === undefined) return true;
    const leftNumeric = /^\d+$/.test(left), rightNumeric = /^\d+$/.test(right);
    if (leftNumeric !== rightNumeric) return !leftNumeric;
    if (leftNumeric && left.length !== right.length) return left.length > right.length;
    return left > right;
  }
  return true;
}

function wait(ms: number, signal: AbortSignal | undefined, clock: Clock): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve(); return; }
    const finish = () => { clock.clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
    const timer = clock.setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

/** Each callback receives a session-scoped sender so old jobs cannot leak into a new connection. */
export async function connectLoop(options: ConnectionOptions): Promise<number> {
  const clock = options.clock ?? nativeClock;
  let failures = 0;
  while (!options.signal?.aborted) {
    const outcome = await connectOnce(options, clock);
    if (outcome.ready) {
      failures = 0;
      if (!options.check) await options.onDisconnect?.();
    }
    if (outcome.exit !== undefined) return outcome.exit;
    if (options.signal?.aborted) return 0;
    const delay = outcome.delay ?? Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5)) * (1 + Math.max(0, Math.min(1, clock.random())) * 0.2);
    options.logger.write('warn', `连接断开，${Number((delay / 1000).toFixed(3))} 秒后重试`, true);
    await wait(delay, options.signal, clock);
  }
  return 0;
}

function connectOnce(options: ConnectionOptions, clock: Clock): Promise<Outcome> {
  return new Promise(resolve => {
    let closed = false;
    let ready = false;
    let versionUnsupported = false;
    let agentVersionError: string | undefined;
    let pinnedCodexVersion: string | undefined;
    let helloTimer: ReturnType<typeof setTimeout> | undefined;
    let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
    let pingTimer: ReturnType<typeof setTimeout> | undefined;
    let pongDeadline: ReturnType<typeof setTimeout> | undefined;
    const url = new URL('/api/member-agent/v1/connect', options.serverUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = (options.socketFactory ?? ((address, config) => new WebSocket(address, config)))(url.href, {
      headers: { Authorization: `Bearer ${options.agentKey}` }, maxPayload: 256 * 1024, agent: false,
    });
    // terminate() on a CONNECTING socket emits an asynchronous error as well.
    // Install this handler before checking an already-aborted signal.
    socket.on('error', () => { if (!closed) options.logger.write('warn', '网络连接失败，请检查服务器地址和网络', true); finish(); });
    const queue = new OutboundQueue(socket, {
      clock,
      onDrop: count => options.logger.write('warn', `已丢弃 ${count} 条输出`),
      onError: () => { options.logger.write('warn', '消息发送失败，正在重新连接', true); finish(); },
    });
    const finish = (outcome: Omit<Outcome, 'ready'> = {}) => {
      if (closed) return;
      closed = true;
      if (helloTimer !== undefined) clock.clearTimeout(helloTimer);
      if (heartbeatTimer !== undefined) clock.clearTimeout(heartbeatTimer);
      if (pingTimer !== undefined) clock.clearTimeout(pingTimer);
      if (pongDeadline !== undefined) clock.clearTimeout(pongDeadline);
      queue.close();
      options.signal?.removeEventListener('abort', aborted);
      socket.terminate();
      resolve({ ...outcome, ready });
    };
    const aborted = () => finish({ exit: 0 });
    const send = (frame: Frame) => {
      if (closed || !ready || options.signal?.aborted) return;
      try { queue.send(frame); }
      catch { options.logger.write('error', '发送消息不符合协议或队列超过上限，正在重新连接', true); finish(); }
    };
    options.signal?.addEventListener('abort', aborted, { once: true });
    if (options.signal?.aborted) { finish({ exit: 0 }); return; }
    const heartbeat = (ms: number) => {
      heartbeatTimer = clock.setTimeout(() => {
        if (closed) return;
        send({ v: 1, type: 'heartbeat' });
        heartbeat(ms);
      }, ms);
    };
    // The server intentionally sends no JSON heartbeat acknowledgment. Native
    // ws control frames detect a half-open connection without changing v1.
    // This deadline is independent of the advertised application heartbeat.
    const watchPong = () => {
      if (pongDeadline !== undefined) clock.clearTimeout(pongDeadline);
      pongDeadline = clock.setTimeout(() => {
        options.logger.write('warn', '服务器 45 秒内未响应连接探测，正在重新连接', true);
        finish();
      }, 45_000);
    };
    const ping = () => {
      if (closed) return;
      try {
        socket.ping('', error => {
          if (!error || closed) return;
          options.logger.write('warn', '连接探测发送失败，正在重新连接', true);
          finish();
        });
      } catch {
        options.logger.write('warn', '连接探测发送失败，正在重新连接', true);
        finish();
      }
      if (!closed) pingTimer = clock.setTimeout(ping, 15_000);
    };
    socket.on('pong', () => { if (ready && !closed) watchPong(); });
    socket.on('unexpected-response', (_request, response) => {
      const status = response.statusCode;
      response.resume();
      if (status === 401) { options.logger.write('error', 'Key 无效或已撤销，请重新配置 Key', true); finish({ exit: 3 }); }
      else if (status === 403) { options.logger.write('error', '服务器拒绝了这条连接的传输方式，请检查服务器地址', true); finish({ exit: 4 }); }
      else if (status === 429) { options.logger.write('warn', '服务器限制了连接频率，至少等待 60 秒后重试', true); finish({ delay: 60_000 }); }
      else { options.logger.write('warn', `服务器拒绝连接（HTTP ${status ?? '未知'}）`, true); finish(); }
    });
    socket.on('open', () => {
      if (closed) return;
      const label = (value: string) => value.slice(0, 255) || 'unknown';
      queue.send({ v: 1, type: 'hello', agentVersion: label(options.version), codexVersion: label(options.codexVersion ?? 'none'), hostname: label(hostname()), platform: label(platform()) });
      helloTimer = clock.setTimeout(() => { options.logger.write('warn', '服务器 10 秒内未响应 hello，正在重新连接', true); finish(); }, 10_000);
    });
    socket.on('close', (code, reason) => {
      if (closed) return;
      options.logger.write('warn', `连接已关闭（${code}）：${reason.toString('utf8') || '对端关闭连接'}`, true);
      finish();
    });
    socket.on('message', (data, binary) => {
      if (closed || options.signal?.aborted) return;
      let frame: Frame;
      try {
        if (binary || Buffer.byteLength(data.toString()) > 256 * 1024) throw new Error();
        const value: unknown = JSON.parse(data.toString());
        if (!value || typeof value !== 'object' || Array.isArray(value) || typeof (value as Frame).type !== 'string') throw new Error();
        frame = value as Frame;
      } catch { options.logger.write('warn', '服务器消息格式无效，正在重新连接', true); finish(); return; }
      if (frame.v !== 1) { options.logger.write('warn', '服务器协议版本不受支持，正在重新连接', true); finish(); return; }
      if (frame.type === 'hello.reject') {
        if (frame.code === 'member_agent_not_allowed') { options.logger.write('error', '这个 Key 对应的智能体不是成员智能体或已被暂停', true); finish({ exit: 4 }); }
        else if (frame.code === 'already_connected') { options.logger.write('warn', '这个智能体已经有另一台电脑在线', true); finish({ delay: 30_000 }); }
        else { options.logger.write('warn', '服务器拒绝了 hello，正在重新连接', true); finish(); }
        return;
      }
      if (frame.type === 'hello.ack') {
        if (ready) { options.logger.write('warn', '忽略重复的 hello.ack'); return; }
        ready = true;
        pinnedCodexVersion = typeof frame.pinnedCodexVersion === 'string' ? frame.pinnedCodexVersion : undefined;
        if (helloTimer !== undefined) clock.clearTimeout(helloTimer);
        options.logger.write('info', `已连接，服务器固定 Codex 版本：${typeof frame.pinnedCodexVersion === 'string' ? frame.pinnedCodexVersion : '未指定'}`, true);
        // Servers predating this field remain compatible. A present but invalid
        // requirement fails closed; it must never silently allow execution.
        if (Object.hasOwn(frame, 'minimumAgentVersion') && !meetsMinimumAgentVersion(options.version, frame.minimumAgentVersion)) {
          const required = typeof frame.minimumAgentVersion === 'string' ? frame.minimumAgentVersion.slice(0, 255).replace(/[\r\n]/g, ' ') : '无效版本';
          agentVersionError = `成员代理当前版本 ${options.version} 低于或不符合服务器要求版本 ${required}；请运行新安装包升级。`;
          options.logger.write('error', agentVersionError, true);
        }
        if (options.codexVersion && options.codexVersion !== 'none') {
          const status = codexVersionStatus(options.codexVersion, frame.pinnedCodexVersion);
          if (status === 'compatible') options.logger.write('warn', `本机 Codex ${options.codexVersion} 与服务器固定版本 ${String(frame.pinnedCodexVersion)} 不同，但都在受支持范围内，继续运行。`, true);
          if (status === 'unsupported') {
            versionUnsupported = true;
            options.logger.write('error', `本机 Codex ${options.codexVersion} 与服务器要求的固定版本 ${typeof frame.pinnedCodexVersion === 'string' ? frame.pinnedCodexVersion : '未知'} 不兼容；需要稳定版 0.149.0 至 0.160.x。`, true);
          }
        }
        try { options.onReady?.(frame); options.onSession?.(send, () => queue.drain()); }
        catch { options.logger.write('error', '连接初始化失败，请查看日志', true); finish({ exit: 1 }); return; }
        if (options.check) { finish({ exit: versionUnsupported || agentVersionError ? 2 : 0 }); return; }
        const seconds = typeof frame.heartbeatSec === 'number' && Number.isFinite(frame.heartbeatSec) && frame.heartbeatSec > 0 ? frame.heartbeatSec : 15;
        heartbeat(seconds * 1000);
        watchPong();
        ping();
        return;
      }
      if (frame.type === 'ping') { if (ready) send({ v: 1, type: 'ping' }); return; }
      if (frame.type === 'heartbeat') return;
      if (!['job.start', 'job.cancel'].includes(frame.type)) { options.logger.write('warn', '忽略服务器发来的未知消息类型'); return; }
      if (!ready) { options.logger.write('warn', '服务器在 hello 完成前发送任务，正在重新连接', true); finish(); return; }
      if (frame.type === 'job.start' && agentVersionError) {
        const jobId = typeof frame.jobId === 'string' ? frame.jobId : '';
        if (jobId) send({ v: 1, type: 'job.result', jobId, exitCode: 1, signal: null, timedOut: false,
          errorCode: 'member_agent_version_outdated', errorMessage: agentVersionError });
        return;
      }
      if (frame.type === 'job.start' && versionUnsupported) {
        const jobId = typeof frame.jobId === 'string' ? frame.jobId : '';
        if (jobId) send({ v: 1, type: 'job.result', jobId, exitCode: 1, signal: null, timedOut: false,
          errorCode: 'member_agent_codex_version_unsupported',
          errorMessage: `本机 Codex ${options.codexVersion} 不受支持；服务器固定版本为 ${pinnedCodexVersion ?? '未知'}，需要稳定版 0.149.0 至 0.160.x。` });
        return;
      }
      // Executor work runs in its own Worker. Never await it on the connection
      // receive path: heartbeat scheduling and cancellation must stay responsive.
      try {
        Promise.resolve(options.onFrame?.(frame)).catch(() => {
          options.logger.write('error', '任务消息处理失败，正在重新连接', true); finish();
        });
      } catch { options.logger.write('error', '任务消息处理失败，正在重新连接', true); finish(); }
    });
  });
}
