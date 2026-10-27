import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";

export interface ProcessIdentity { pid: number; creationTime: string }
export interface ProcessRow extends ProcessIdentity { parentPid: number }

export function parseProcessRows(stdout: string): ProcessRow[] {
  const parsed: unknown = JSON.parse(stdout);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.map((row) => {
    if (!row || typeof row !== "object") throw new Error("Invalid process snapshot");
    const value = row as Record<string, unknown>;
    if (!Number.isSafeInteger(value.pid) || !Number.isSafeInteger(value.parentPid) ||
        typeof value.creationTime !== "string" || !/^[0-9]{15,20}$/.test(value.creationTime)) throw new Error("Invalid process identity");
    return { pid: value.pid as number, parentPid: value.parentPid as number, creationTime: value.creationTime };
  });
}

interface SamplerOptions {
  intervalMs: number;
  restartDelayMs?: number;
  onRows: (rows: ProcessRow[]) => void;
  warn: (message: string) => void;
  // Test seam; production always launches the absolute SystemRoot PowerShell path below.
  launch?: (executable: string, args: string[]) => ChildProcessWithoutNullStreams;
}

interface QueryProcess {
  child: ChildProcessWithoutNullStreams;
  closed: Promise<void>;
  failed: boolean;
}

/** One query process per tracker, not one PowerShell launch per sample. */
export class WindowsProcessSampler {
  private current: QueryProcess | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private restarts = 0;
  private warned = false;
  private started = false;
  private stopping = false;
  private stopPromise: Promise<void> | null = null;
  private finalSample: (() => void) | null = null;
  private sampleRequested = false;
  private requestSequence = 0;
  private finalRequestId: string | null = null;
  private readonly exitListener = () => {
    try { this.current?.child.kill(); } catch { /* The stdin/owner guard also terminates the sampler. */ }
  };

  constructor(privateOptions: SamplerOptions) { this.options = privateOptions; }
  private readonly options: SamplerOptions;
  get pid(): number | null { return this.current?.child.pid ?? null; }

  start(): void {
    if (this.started || this.stopping) return;
    this.started = true;
    process.once("exit", this.exitListener);
    this.launch();
  }

  requestSample(): void {
    if (!this.current || this.current.failed || this.sampleRequested || this.stopping) return;
    this.sampleRequested = true;
    this.current.child.stdin.write("sample:\n");
  }

  private warnOnce(): void {
    if (this.warned) return;
    this.warned = true;
    try { this.options.warn("执行器进程树快照查询失败；最多退避重启 3 次，继续使用已记录的进程身份清理"); } catch { /* Diagnostics cannot fail a task. */ }
  }

  private scheduleRestart(): void {
    if (this.stopping || this.restarts >= 3 || this.restartTimer) return;
    this.restarts++;
    this.restartTimer = setTimeout(() => { this.restartTimer = null; this.launch(); }, this.options.restartDelayMs ?? 10_000);
  }

  private launch(): void {
    if (this.stopping) return;
    try {
      const systemRoot = process.env.SystemRoot;
      if (!systemRoot) throw new Error("SystemRoot missing");
      const executable = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const script = [
        "$ErrorActionPreference = 'Stop'",
        "$encoding = New-Object Text.UTF8Encoding($false)",
        "[Console]::OutputEncoding = $encoding",
        `$owner = [Diagnostics.Process]::GetProcessById(${process.pid})`,
        "$null = $owner.Handle",
        // A real StreamReader has asynchronous reads; Console.In is a synchronized reader in PS 5.1.
        "$inputReader = New-Object IO.StreamReader([Console]::OpenStandardInput(), $encoding)",
        "$next = $inputReader.ReadLineAsync()",
        "$requestId = $null",
        "while (-not $owner.HasExited) {",
        "$rows = @(foreach ($row in (Get-CimInstance -Query 'SELECT ProcessId,ParentProcessId,CreationDate FROM Win32_Process')) { [pscustomobject]@{ pid = [int]$row.ProcessId; parentPid = [int]$row.ParentProcessId; creationTime = $row.CreationDate.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture) } })",
        "[Console]::Out.WriteLine((ConvertTo-Json -InputObject ([pscustomobject]@{ requestId = $requestId; rows = $rows }) -Compress))",
        "[Console]::Out.Flush()",
        "$requestId = $null",
        `if ($next.Wait(${Math.max(1, Math.floor(this.options.intervalMs))})) {`,
        "$command = $next.Result",
        "if ($null -eq $command -or $command -eq 'stop') { break }",
        "if ($command.StartsWith('sample:')) { $requestId = $command.Substring(7) }",
        "$next = $inputReader.ReadLineAsync()",
        "}",
        "}",
      ].join("\n");
      const child = this.options.launch
        ? this.options.launch(executable, ["-NoProfile", "-NonInteractive", "-Command", script])
        : spawn(executable, ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      let onClose!: () => void;
      const entry: QueryProcess = { child, closed: new Promise<void>(resolve => { onClose = resolve; }), failed: false };
      this.current = entry;
      this.sampleRequested = true;
      let buffer = "";
      const fail = () => {
        if (entry.failed) return;
        entry.failed = true;
        this.warnOnce();
        child.kill();
      };
      child.stdin.on("error", fail);
      child.on("error", fail);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (entry.failed) return;
        buffer += chunk;
        if (Buffer.byteLength(buffer, "utf8") > 8 * 1024 * 1024) { fail(); return; }
        let newline: number;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
          try {
            const response: unknown = JSON.parse(line);
            if (!response || typeof response !== "object" || !Array.isArray((response as { rows?: unknown }).rows) ||
                !((response as { requestId?: unknown }).requestId === null || typeof (response as { requestId?: unknown }).requestId === "string")) throw new Error("Invalid sampler frame");
            const envelope = response as { requestId: string | null; rows: unknown[] };
            const rows = parseProcessRows(JSON.stringify(envelope.rows));
            this.options.onRows(rows.filter(row => row.pid !== child.pid));
            this.sampleRequested = false;
            if (envelope.requestId === this.finalRequestId && this.finalSample) this.finalSample();
          } catch { fail(); return; }
        }
      });
      // Never forward raw query errors or environment details into job logs.
      child.stderr.resume();
      child.once("close", () => {
        onClose();
        if (this.current === entry) this.current = null;
        this.finalSample?.();
        if (!this.stopping) { this.warnOnce(); this.scheduleRestart(); }
      });
    } catch {
      this.warnOnce();
      this.scheduleRestart();
    }
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.stopPromise = this.close();
    return this.stopPromise;
  }

  private async close(): Promise<void> {
    try {
      const entry = this.current;
      if (!entry) return;
      if (!entry.failed) {
        // Request a last sample; never wait longer than one configured interval for it.
        await new Promise<void>(resolve => {
          const requestId = `stop-${++this.requestSequence}`;
          this.finalRequestId = requestId;
          const timer = setTimeout(() => { this.warnOnce(); finish(); }, this.options.intervalMs);
          const finish = () => { clearTimeout(timer); this.finalSample = null; this.finalRequestId = null; resolve(); };
          this.finalSample = finish;
          entry.child.stdin.write(`sample:${requestId}\n`);
        });
      }
      // Kill our own child handle, then wait for close (all stdio handles also closed).
      entry.child.kill();
      await entry.closed;
    } finally { process.removeListener("exit", this.exitListener); }
  }
}
