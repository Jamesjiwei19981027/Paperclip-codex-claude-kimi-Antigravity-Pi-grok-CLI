import { Worker } from 'node:worker_threads';
import { StringDecoder } from 'node:string_decoder';
import type { Logger } from './logger.ts';
import { chunkUtf8, validateEvent, validateMeta, validateResult, validateUsage } from './protocol.ts';
import type { Frame, JobStart } from './protocol.ts';
import type { ExecutorResult } from './executors/types.ts';
import { ProcessTreeTracker, terminateProcessTree, terminateRecordedProcess } from './process-tree.ts';
import type { ProcessRow } from './process-tree.ts';

interface ActiveJob {
 job: JobStart;
 worker: Worker | null;
 logSeq: number;
 eventSeq: number;
 suppressed: boolean;
 stopping: boolean;
 timedOut: boolean;
 result: ExecutorResult | null;
 timer: ReturnType<typeof setTimeout> | null;
 stopTimer: ReturnType<typeof setTimeout> | null;
 done: Promise<void>;
 resolve: () => void;
 finishing: boolean;
 finishPromise: Promise<void> | null;
 childPids: Set<number>;
 childPidOverflowLogged: boolean;
 discardedMetaUsage: number;
 cleanupFailureMessage: string | null;
 cleanupPromise: Promise<void> | null;
 processTracker: ProcessTreeTracker;
}

type TreeTerminator = (pid: number) => Promise<void>;

interface RunnerOptions {
 serverUrl: string;
 logger: Logger;
 send: (frame: Frame) => void;
 executorUrl?: URL;
 executorData?: unknown;
 echoHoldSec?: number;
 terminateTree?: TreeTerminator;
 processSnapshotIntervalMs?: number;
 processSnapshotRestartDelayMs?: number;
 queryProcesses?: () => Promise<ProcessRow[]>;
}

export class JobRunner {
 private active: ActiveJob | null = null;
 private accepting = true;
 private send: (frame: Frame) => void;
 private readonly options: RunnerOptions;

 constructor(options: RunnerOptions) { this.options = options; this.send = options.send; }
 get busy() { return this.active !== null; }
 setSender(send: (frame: Frame) => void) { this.send = send; }

 private safe(value: unknown): any {
  if (typeof value === 'string') return this.options.logger.redactor.redact(value);
  if (Array.isArray(value)) return value.map(item => this.safe(item));
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [this.options.logger.redactor.redact(key), this.safe(item)]));
  return value;
 }

 start(job: JobStart) {
  if (!this.accepting) return;
  this.options.logger.redactor.register(job.authToken, job.runtimeTools?.bearerToken);
  if (this.active) {
   this.send(this.safe({ v: 1, type: 'job.result', jobId: job.jobId, exitCode: 1, signal: null, timedOut: false, errorCode: 'member_agent_busy', errorMessage: '成员代理正在执行其他任务' }));
   return;
  }
  let resolve!: () => void;
  const done = new Promise<void>(r => { resolve = r; });
  const active: ActiveJob = {
   job, worker: null, logSeq: 0, eventSeq: 0, suppressed: false, stopping: false, timedOut: false,
   result: null, timer: null, stopTimer: null, done, resolve, finishing: false, finishPromise: null,
   childPids: new Set(), childPidOverflowLogged: false, discardedMetaUsage: 0,
   cleanupFailureMessage: null, cleanupPromise: null,
   processTracker: new ProcessTreeTracker({
    intervalMs: this.options.processSnapshotIntervalMs,
    restartDelayMs: this.options.processSnapshotRestartDelayMs,
    query: this.options.queryProcesses,
    warn: message => this.options.logger.write('warn', message),
   }),
  };
  this.active = active;
  // Confirm receipt before module loading, worker creation, or any executor preparation.
  try {
   this.send({ v: 1, type: 'job.accepted', jobId: job.jobId });
   this.options.logger.write('info', `收到任务 ${job.jobId}`, true);
   const worker = new Worker(new URL('./executor-worker.ts', import.meta.url), {
    workerData: { job, serverUrl: this.options.serverUrl, executorUrl: (this.options.executorUrl ?? new URL('./executors/echo.ts', import.meta.url)).href, executorData: this.options.executorData, echoHoldSec: this.options.echoHoldSec ?? 0 },
    stdout: true, stderr: true, execArgv: [],
   });
   active.worker = worker;
   for (const [stream, pipe] of [['stdout', worker.stdout], ['stderr', worker.stderr]] as const) {
    const decoder = new StringDecoder('utf8');
    pipe?.on('data', data => this.log(active, stream, decoder.write(data)));
    pipe?.on('end', () => this.log(active, stream, decoder.end()));
   }
   worker.on('message', message => {
    if (this.active !== active || active.finishing || active.suppressed) return;
    if (!message || typeof message !== 'object') return;
    try {
     if (message.type === 'log' && ['stdout', 'stderr'].includes(message.stream) && typeof message.text === 'string') {
      this.log(active, message.stream, message.text);
     } else if (message.type === 'event') {
      const event = validateEvent(message.event);
      this.send(this.safe({ v: 1, type: 'job.event', jobId: job.jobId, seq: ++active.eventSeq, event }));
     } else if (message.type === 'meta') {
      let meta: ReturnType<typeof validateMeta> | undefined;
      try {
       meta = validateMeta(message.meta);
      } catch { this.discardMetaUsage(active); }
      if (meta) this.send(this.safe({ v: 1, type: 'job.meta', jobId: job.jobId, meta }));
     } else if (message.type === 'usage') {
      let usage: ReturnType<typeof validateUsage> | undefined;
      try {
       usage = validateUsage(message.usage);
      } catch { this.discardMetaUsage(active); }
      if (usage) this.send(this.safe({ v: 1, type: 'job.usage', jobId: job.jobId, usage }));
     } else if (message.type === 'childSpawned') {
      this.registerChild(active, message.pid);
     } else if (message.type === 'result') {
      active.result = validateResult(message.result);
      void worker.terminate();
     }
    } catch {
     active.result = { exitCode: 1, signal: null, timedOut: false, errorCode: 'member_agent_executor_error', errorMessage: '执行器返回了无效协议字段' };
     void worker.terminate();
    }
   });
   worker.on('error', () => {
    active.result = { exitCode: 1, signal: null, timedOut: false, errorCode: 'member_agent_executor_error', errorMessage: '执行器线程发生内部错误，请检查程序文件' };
   });
   worker.on('exit', () => { void this.finish(active); });
   const maxRunSec = job.config?.maxRunSec ?? 3600;
   active.timer = setTimeout(() => { void this.stop(active, 20, true); }, maxRunSec * 1000);
  } catch {
   active.result = { exitCode: 1, signal: null, timedOut: false, errorCode: 'member_agent_executor_error', errorMessage: '无法启动执行器，请检查 Node 版本与程序文件' };
   void this.finish(active);
  }
 }

 private discardMetaUsage(active: ActiveJob) {
  active.discardedMetaUsage++;
 }

 private registerChild(active: ActiveJob, pid: unknown) {
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0) {
   this.options.logger.write('warn', '忽略无效的执行器子进程号');
   return;
  }
  const value = pid as number;
  if (active.childPids.has(value)) return;
  if (active.childPids.size >= 64) {
   if (!active.childPidOverflowLogged) {
    active.childPidOverflowLogged = true;
    this.options.logger.write('warn', '执行器登记的子进程超过 64 个，后续进程号将被忽略');
   }
   return;
  }
  active.childPids.add(value);
  active.processTracker.track(value);
 }

 private log(active: ActiveJob, stream: 'stdout' | 'stderr', text: string) {
  if (active.suppressed || active.finishing) return;
  const safe = this.options.logger.redactor.chunk(`${active.job.jobId}:${stream}`, text);
  if (!safe) return;
  this.options.logger.write(stream === 'stderr' ? 'warn' : 'info', safe);
  for (const chunk of chunkUtf8(safe)) this.send({ v: 1, type: 'job.log', jobId: active.job.jobId, seq: ++active.logSeq, stream, chunk });
 }

 private terminateChildren(active: ActiveJob): Promise<void> {
  if (active.cleanupPromise) return active.cleanupPromise;
  active.cleanupPromise = (async () => {
   const records = await active.processTracker.stop();
   const identities = new Map(records.map(identity => [identity.pid, identity]));
   const terminate = this.options.terminateTree ?? (async (pid: number) => {
    const identity = identities.get(pid);
    if (identity) await terminateRecordedProcess(identity, true);
    else await terminateProcessTree(pid);
   });
   // Clean every registered tree concurrently: up to 64 PIDs are allowed,
   // and serial taskkill timeouts could exceed the server's cancellation window.
   const outcomes = await Promise.all([...active.childPids].map(async pid => {
    try { await terminate(pid); return null; }
    catch {
     this.options.logger.write('error', `无法终止进程树 ${pid}，请手动检查该进程及其子进程`, true);
     return pid;
    }
   }));
   // Roots may already be gone: finish every retained descendant using its exact creation time.
   const recordedOutcomes = await Promise.all(records.map(async identity => {
    try { await terminateRecordedProcess(identity); return null; }
    catch {
     this.options.logger.write('error', `无法终止快照进程 ${identity.pid}，请手动检查该进程`, true);
     return identity.pid;
    }
   }));
   const failures = [...new Set([...outcomes, ...recordedOutcomes].filter((pid): pid is number => pid !== null))];
   if (failures.length) {
    active.cleanupFailureMessage = `本机进程可能未完全结束，请手动检查进程 ${failures.join(', ')}`;
   }
  })();
  return active.cleanupPromise;
 }

 private finish(active: ActiveJob): Promise<void> {
  if (active.finishPromise) return active.finishPromise;
  active.finishing = true;
  active.finishPromise = this.finishOnce(active);
  return active.finishPromise;
 }

 private async finishOnce(active: ActiveJob): Promise<void> {
  let resultSent = false;
  if (active.timer) clearTimeout(active.timer);
  if (active.stopTimer) clearTimeout(active.stopTimer);
  try {
   // A returned result is not sufficient proof that Codex's process tree exited.
   await this.terminateChildren(active);
   for (const stream of ['stdout', 'stderr']) {
    const safe = this.options.logger.redactor.finish(`${active.job.jobId}:${stream}`);
    if (safe && !active.suppressed) {
     this.options.logger.write('info', safe);
     for (const chunk of chunkUtf8(safe)) this.send({ v: 1, type: 'job.log', jobId: active.job.jobId, seq: ++active.logSeq, stream, chunk });
    }
   }
   if (active.discardedMetaUsage > 0) this.options.logger.write('warn', `任务结束前已丢弃 ${active.discardedMetaUsage} 条无效 meta/usage`);
   let result = active.result ?? { exitCode: 1, signal: null, timedOut: false, errorCode: 'member_agent_executor_error', errorMessage: '执行器未返回结果' };
   if (active.stopping) result = { exitCode: 1, signal: null, timedOut: active.timedOut, errorCode: active.timedOut ? 'member_agent_timeout' : 'cancelled', errorMessage: active.timedOut ? '任务超过本机时长上限' : '任务已取消' };
   if (active.cleanupFailureMessage) {
    result = {
     ...result,
     exitCode: 1,
     errorCode: 'member_agent_process_tree_termination_failed',
     errorMessage: [result.errorMessage, active.cleanupFailureMessage].filter(Boolean).join('；'),
    };
   }
   this.options.logger.write('info', `任务结束 ${active.job.jobId}：${result.exitCode === 0 ? '成功' : result.errorCode ?? '失败'}`, true);
   if (!active.suppressed) {
    const frame = this.safe({ v: 1, type: 'job.result', jobId: active.job.jobId, ...validateResult(result) });
    resultSent = true;
    this.send(frame);
   }
  } catch {
   if (!active.suppressed && !resultSent) {
    try { this.send({ v: 1, type: 'job.result', jobId: active.job.jobId, exitCode: 1, signal: null, timedOut: false, errorCode: 'member_agent_executor_error', errorMessage: '任务收尾失败，请检查本机日志目录与连接' }); }
    catch { /* The connection owns transport error handling. */ }
   }
  } finally {
   if (this.active === active) this.active = null;
   active.resolve();
  }
 }

 private stop(active: ActiveJob, graceSec: number, timedOut = false): Promise<void> {
  if (active.finishing || active.stopping) return active.done;
  active.stopping = true;
  active.timedOut = timedOut;
  if (!active.worker) { void this.finish(active); return active.done; }
  active.worker.postMessage({ type: 'cancel' });
  active.stopTimer = setTimeout(() => {
   void active.worker?.terminate().catch(() => {}).then(() => this.finish(active));
  }, Math.max(0, graceSec) * 1000);
  return active.done;
 }

 async cancel(jobId: string, graceSec = 20) {
  if (!this.active || this.active.job.jobId !== jobId) {
   this.options.logger.write('warn', '忽略不属于当前任务的取消请求');
   return;
  }
  await this.stop(this.active, graceSec);
 }

 async disconnect(graceSec = 20) {
  if (!this.active) return;
  const active = this.active;
  active.suppressed = true;
  try { this.options.logger.write('warn', `连接断开，已中止任务 ${active.job.jobId}`, true); }
  finally { await this.stop(active, graceSec); }
 }

 async shutdown() {
  this.accepting = false;
  if (this.active) await this.stop(this.active, 20);
 }

 async force(): Promise<void> {
  this.accepting = false;
  const active = this.active;
  if (!active) return;
  active.suppressed = true;
  active.stopping = true;
  if (active.worker) await active.worker.terminate().catch(() => {});
  await this.finish(active);
 }
}
