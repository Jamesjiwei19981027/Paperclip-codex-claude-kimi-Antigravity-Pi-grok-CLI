import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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
