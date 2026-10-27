// Only a test fixture: creates no service and performs no network requests.
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.argv[2] === "grandchild") {
  process.send?.({ ready: true });
} else {
  const grandchild = fork(fileURLToPath(import.meta.url), ["grandchild"], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  grandchild.once("message", () => process.send?.({ grandchildPid: grandchild.pid }));
}
setInterval(() => {}, 1_000);
