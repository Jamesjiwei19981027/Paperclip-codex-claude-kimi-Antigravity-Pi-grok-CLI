// Only a test fixture: creates no service and performs no network requests.
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

if (process.argv[2] === "grandchild") {
  process.send?.({ ready: true });
} else {
  const grandchild = fork(fileURLToPath(import.meta.url), ["grandchild"], { stdio: ["ignore", "ignore", "ignore", "ipc"], detached: Boolean(process.argv[2]) });
  grandchild.once("message", () => process.send?.({ grandchildPid: grandchild.pid }));
  if (process.argv[2]) setInterval(() => {
    if (!existsSync(process.argv[2])) return;
    grandchild.disconnect();
    process.exit(0);
  }, 10);
}
setInterval(() => {}, 1_000);
