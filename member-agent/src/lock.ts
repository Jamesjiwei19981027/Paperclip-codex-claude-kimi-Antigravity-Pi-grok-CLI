import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export class LockError extends Error {
  readonly code = 5;
  constructor(message: string) { super(message); this.name = "LockError"; }
}

function isLive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

function livePid(text: string): number | undefined {
  const pid = /^\d+$/.test(text.trim()) ? Number(text.trim()) : NaN;
  return Number.isSafeInteger(pid) && pid > 0 && isLive(pid) ? pid : undefined;
}

async function unlinkIfSame(file: string, identity: { ino: number; birthtimeMs: number }): Promise<void> {
  try {
    const now = await stat(file);
    if (now.ino === identity.ino && now.birthtimeMs === identity.birthtimeMs) await unlink(file);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

// Serialize stale-lock replacement within the process as well as exclusive creation
// across processes. The exclusive recovery file protects cross-process reclamation.
const pendingAcquisitions = new Map<string, Promise<void>>();

export async function acquireLock(dir: string): Promise<() => Promise<void>> {
  await mkdir(dir, { recursive: true });
  const lockPath = path.resolve(dir, "agent.lock");
  const previous = pendingAcquisitions.get(lockPath) ?? Promise.resolve();
  let complete!: () => void;
  const current = new Promise<void>((resolve) => { complete = resolve; });
  pendingAcquisitions.set(lockPath, current);
  await previous;
  try {
    const recoveryPath = lockPath + ".recovery";
    // Link a fully written PID file so other processes never observe an empty
    // lock between exclusive creation and writing its owner PID.
    const stagingPath = lockPath + `.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(stagingPath, String(process.pid), { encoding: "utf8", flag: "wx" });
    const stagingIdentity = await stat(stagingPath);
    let acquired = false;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        try { await link(stagingPath, recoveryPath); acquired = true; break; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          try {
            const identity = await stat(recoveryPath);
            const pid = livePid(await readFile(recoveryPath, "utf8"));
            if (pid) throw new LockError(`已有代理正在获取本机锁（进程号 ${pid}），请稍后重试。`);
            await unlinkIfSame(recoveryPath, identity);
          } catch (readError) { if ((readError as NodeJS.ErrnoException).code !== "ENOENT") throw readError; }
        }
      }
      if (!acquired) throw new LockError("已有代理正在获取本机锁，请稍后重试。");
      let existing: string | undefined;
      try { existing = await readFile(lockPath, "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (existing !== undefined) {
        const pid = livePid(existing);
        if (pid) throw new LockError(`已有代理在运行（进程号 ${pid}），请先退出另一个实例。`);
        await unlink(lockPath);
      }
      await link(stagingPath, lockPath);
      const identity = await stat(lockPath);
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        try {
          const now = await stat(lockPath);
          if (now.ino === identity.ino && now.birthtimeMs === identity.birthtimeMs && (await readFile(lockPath, "utf8")) === String(process.pid)) await unlink(lockPath);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      };
    } finally {
      try { if (acquired) await unlinkIfSame(recoveryPath, stagingIdentity); }
      finally { await unlink(stagingPath); }
    }
  } finally {
    complete();
    if (pendingAcquisitions.get(lockPath) === current) pendingAcquisitions.delete(lockPath);
  }
}
