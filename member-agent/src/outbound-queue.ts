import type { Frame } from './protocol.ts';

export interface QueueSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string, callback: (error?: Error) => void): void;
}
interface QueuedFrame { data: string; bytes: number; log: boolean }
interface QueueOptions {
  onDrop?: (count: number) => void;
  onError?: (error: Error) => void;
  clock?: Pick<import('./connection.ts').Clock, 'setTimeout' | 'clearTimeout'>;
}

/** At most one ws send is outstanding; only log frames may be evicted. */
export class OutboundQueue {
  private readonly socket: QueueSocket;
  private readonly options: QueueOptions;
  private pending: QueuedFrame[] = [];
  private bytes = 0;
  private inFlight: QueuedFrame | undefined;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private drainWaiters = new Set<(success: boolean) => void>();
  private readonly clock: Pick<import('./connection.ts').Clock, 'setTimeout' | 'clearTimeout'>;
  constructor(socket: QueueSocket, options: QueueOptions = {}) {
    this.socket = socket;
    this.options = options;
    this.clock = options.clock ?? { setTimeout, clearTimeout };
  }
  send(frame: Frame): void {
    if (this.stopped) return;
    const data = JSON.stringify(frame);
    const item = { data, bytes: Buffer.byteLength(data), log: frame.type === 'job.log' };
    if (item.bytes > 256 * 1024) throw new Error('发送帧超过 256 KB');
    this.pending.push(item);
    this.bytes += item.bytes;
    let dropped = 0;
    while (this.pending.length + (this.inFlight ? 1 : 0) > 1000 || this.bytes + (this.inFlight?.bytes ?? 0) > 8 * 1024 * 1024) {
      const index = this.pending.findIndex(value => value.log);
      if (index < 0) {
        // Critical frames are never silently lost. Fail the session if its
        // producer violates the finite single-job transport budget.
        this.close();
        throw new Error('关键消息队列超过上限，连接必须中止');
      }
      const [removed] = this.pending.splice(index, 1);
      this.bytes -= removed!.bytes;
      dropped++;
    }
    if (dropped) this.options.onDrop?.(dropped);
    this.flush();
  }
  private flush(): void {
    if (this.stopped || this.inFlight || this.pending.length === 0 || this.socket.readyState !== 1) return;
    if (this.socket.bufferedAmount >= 256 * 1024) {
      // ws has no drain event. A bounded timer is only needed when its existing
      // buffer was filled outside this queue; ordinary draining uses callbacks.
      this.timer ??= this.clock.setTimeout(() => { this.timer = undefined; this.flush(); }, 50);
      return;
    }
    const item = this.pending.shift()!;
    this.bytes -= item.bytes;
    this.inFlight = item;
    try {
      this.socket.send(item.data, error => {
        if (this.stopped) return;
        this.inFlight = undefined;
        if (error) { this.close(); this.options.onError?.(error); return; }
        this.flush();
        if (!this.inFlight && this.pending.length === 0) {
          for (const finish of [...this.drainWaiters]) finish(true);
        }
      });
    } catch (error) {
      this.close();
      this.options.onError?.(error instanceof Error ? error : new Error('消息发送失败'));
    }
  }
  /** Wait for ws send callbacks, bounded so shutdown cannot hang indefinitely. */
  drain(timeoutMs = 5000): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false);
    if (!this.inFlight && this.pending.length === 0) return Promise.resolve(true);
    return new Promise(resolve => {
      const finish = (success: boolean) => {
        if (!this.drainWaiters.delete(finish)) return;
        this.clock.clearTimeout(timer);
        resolve(success);
      };
      const boundedMs = Number.isFinite(timeoutMs) ? Math.max(0, Math.min(timeoutMs, 5000)) : 5000;
      const timer = this.clock.setTimeout(() => finish(false), boundedMs);
      this.drainWaiters.add(finish);
    });
  }
  close(): void {
    this.stopped = true;
    this.pending = [];
    this.bytes = 0;
    this.inFlight = undefined;
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    for (const finish of [...this.drainWaiters]) finish(false);
  }
}
