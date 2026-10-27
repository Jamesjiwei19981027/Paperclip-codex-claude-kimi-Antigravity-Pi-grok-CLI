import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { WindowsProcessSampler, parseProcessRows } from "./process-sampler.ts";
import type { ProcessIdentity, ProcessRow } from "./process-sampler.ts";
export type { ProcessIdentity, ProcessRow } from "./process-sampler.ts";

const execFileAsync = promisify(execFile);

export interface ProcessTreeTrackerOptions {
  intervalMs?: number;
  restartDelayMs?: number;
  query?: () => Promise<ProcessRow[]>;
  warn: (message: string) => void;
}

const processIdentityTicks = "^[0-9]{15,20}$";

function windowsPowerShellPath(): string {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot) throw new Error("无法确定 Windows 系统目录。");
  return path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/** Tracks descendants by PID plus the OS creation timestamp, retaining records after a parent exits. */
export class ProcessTreeTracker {
  private readonly intervalMs: number;
  private readonly query: (() => Promise<ProcessRow[]>) | undefined;
  private readonly sampler: WindowsProcessSampler | null;
  private readonly warn: (message: string) => void;
  private readonly roots = new Map<number, ProcessIdentity | null>();
  private readonly records = new Map<number, ProcessIdentity>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private pending: Promise<void> | null = null;
  private stopped = false;
  private stopPromise: Promise<ProcessIdentity[]> | null = null;

  constructor(options: ProcessTreeTrackerOptions) {
    this.intervalMs = Number.isFinite(options.intervalMs) && (options.intervalMs ?? 0) > 0 ? options.intervalMs! : 3_000;
    this.query = options.query;
    this.warn = options.warn;
    this.sampler = this.query ? null : new WindowsProcessSampler({ intervalMs: this.intervalMs, restartDelayMs: options.restartDelayMs, onRows: rows => this.record(rows), warn: options.warn });
  }

  get queryProcessPid(): number | null { return this.sampler?.pid ?? null; }

  track(pid: number): void {
    if (this.stopped || !Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid || this.roots.has(pid)) return;
    this.roots.set(pid, null);
    if (this.sampler) { this.sampler.start(); this.sampler.requestSample(); }
    else {
      if (!this.timer) this.timer = setInterval(() => { void this.capture(); }, this.intervalMs);
      void this.capture();
    }
  }

  identities(): ProcessIdentity[] {
    return [...this.records.values()].map((record) => ({ ...record }));
  }

  private async capture(): Promise<void> {
    if (this.stopped) return;
    if (this.pending) return this.pending;
    if (this.roots.size === 0) return;
    const run = (async () => {
      try {
        this.record(await this.query!());
      } catch {
        try { this.warn("执行器进程树快照查询失败；继续使用已记录的进程身份清理"); } catch { /* Diagnostics must not fail the task. */ }
      }
    })();
    this.pending = run;
    try { await run; }
    finally { if (this.pending === run) this.pending = null; }
  }

  private record(rows: ProcessRow[]): void {
    const current = new Map(rows.map((row) => [row.pid, row]));
    const seeds = new Map<number, ProcessIdentity>();
    for (const [pid, identity] of this.roots) {
      const row = current.get(pid);
      if (!row) continue;
      if (identity && identity.creationTime !== row.creationTime) continue;
      const accepted = identity ?? { pid, creationTime: row.creationTime };
      this.roots.set(pid, accepted);
      seeds.set(pid, accepted);
    }
    // A previously observed descendant remains a tree root for discovery after its parents exit.
    for (const identity of this.records.values()) {
      if (current.get(identity.pid)?.creationTime === identity.creationTime) seeds.set(identity.pid, identity);
    }
    const children = new Map<number, ProcessRow[]>();
    for (const row of rows) {
      const group = children.get(row.parentPid) ?? [];
      group.push(row);
      children.set(row.parentPid, group);
    }
    const queue = [...seeds.values()];
    const visited = new Set<number>();
    while (queue.length) {
      const parent = queue.shift()!;
      if (visited.has(parent.pid) || current.get(parent.pid)?.creationTime !== parent.creationTime) continue;
      visited.add(parent.pid);
      this.records.set(parent.pid, { ...parent });
      for (const child of children.get(parent.pid) ?? []) {
        if (BigInt(child.creationTime) < BigInt(parent.creationTime)) continue;
        const existing = this.records.get(child.pid);
        if (existing && existing.creationTime !== child.creationTime) continue;
        queue.push({ pid: child.pid, creationTime: child.creationTime });
      }
    }
  }

  stop(): Promise<ProcessIdentity[]> {
    if (!this.stopPromise) this.stopPromise = (async () => {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      if (this.sampler) await this.sampler.stop();
      else if (this.pending) await this.pending;
      else await this.capture();
      this.stopped = true;
      return this.identities();
    })();
    return this.stopPromise;
  }
}

async function readWindowsProcessIdentity(pid: number): Promise<ProcessIdentity | null> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$row = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId=${pid}'`,
    "if ($null -eq $row) { exit 0 }",
    "[pscustomobject]@{ pid = [int]$row.ProcessId; parentPid = [int]$row.ParentProcessId; creationTime = $row.CreationDate.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture) } | ConvertTo-Json -Compress",
  ].join("; ");
  const { stdout } = await execFileAsync(windowsPowerShellPath(), ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true, timeout: 5_000, encoding: "utf8",
  });
  const row = stdout.trim() ? parseProcessRows(stdout)[0] : undefined;
  return row ? { pid: row.pid, creationTime: row.creationTime } : null;
}

async function terminateWindowsIdentity(identity: ProcessIdentity, tree: boolean): Promise<boolean> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `try { $p = [Diagnostics.Process]::GetProcessById(${identity.pid}) } catch [ArgumentException] { exit 0 }`,
    "$null = $p.Handle",
    // Win32_Process exposes microseconds, whereas Process.StartTime can retain 100 ns ticks.
    `$created = $p.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture) -replace '.$', '0'`,
    `if ($created -ne '${identity.creationTime}') { exit 0 }`,
    ...(tree
      ? [
          "$taskkill = Join-Path $env:SystemRoot 'System32\\taskkill.exe'",
          `& $taskkill /PID ${identity.pid} /T /F`,
          "if ($LASTEXITCODE -ne 0 -and -not $p.HasExited) { throw 'taskkill failed' }",
        ]
      : ["$p.Kill()"]),
    "if (-not $p.WaitForExit(5000)) { throw 'process did not exit' }",
    "[Console]::Out.Write('terminated')",
  ].join("; ");
  try {
    const { stdout } = await execFileAsync(windowsPowerShellPath(), ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true, timeout: 7_000, encoding: "utf8",
    });
    return stdout.endsWith("terminated");
  } catch {
    // A concurrently exiting process is already cleaned up; the held Process handle prevents PID reuse.
    const current = await readWindowsProcessIdentity(identity.pid);
    if (current?.creationTime !== identity.creationTime) return false;
    throw new Error("无法结束已核对身份的进程。");
  }
}

/** Rechecks identity immediately before termination and never targets a reused PID. */
export async function terminateRecordedProcess(
  identity: ProcessIdentity,
  tree = false,
): Promise<boolean> {
  if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0 || identity.pid === process.pid || !new RegExp(processIdentityTicks).test(identity.creationTime)) {
    throw new Error("进程身份无效，不能终止。");
  }
  if (process.platform !== "win32") throw new Error("本阶段仅支持 Windows 进程树终止。");
  return terminateWindowsIdentity(identity, tree);
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw new Error(`无法确认进程 ${pid} 是否已退出。`); }
}

/** Call only for child PIDs tracked by the executor, never for server-supplied IDs. */
export async function terminateProcessTree(pid: number): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) throw new Error("进程号无效，不能终止进程树。");
  if (process.platform !== "win32") throw new Error("本阶段仅支持 Windows 进程树终止。");
  if (!processExists(pid)) return;
  try {
    await execFileAsync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 5_000, encoding: "utf8" });
  } catch {
    // The process may exit naturally after the initial existence check but
    // before taskkill opens it. Treat that race as successful cleanup.
    if (!processExists(pid)) return;
    throw new Error(`无法终止进程树 ${pid}：taskkill 失败，请检查进程权限。`);
  }
  // taskkill can report before handles disappear; keep verification bounded.
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!processExists(pid)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`无法确认进程树 ${pid} 已终止，进程仍存在。`);
}
