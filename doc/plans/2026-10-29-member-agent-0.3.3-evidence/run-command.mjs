import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [logName, cwd, command, ...args] = process.argv.slice(2);
if (!args.length) throw new Error("Usage: run-command.mjs log cwd command args...");
const output = new URL(logName, import.meta.url);
const privateValues = [...new Set([os.hostname(), os.userInfo().username, process.env.USERDOMAIN, process.env.COMPUTERNAME].filter(Boolean))];
const sanitize = text => privateValues.reduce((value, token) => value.replaceAll(token, "[redacted]"), text)
  .replace(/\x1b\[[0-9;]*m/g, "");
fs.writeFileSync(output, "");
const write = text => { const clean = sanitize(text); fs.appendFileSync(output, clean); process.stdout.write(clean); };
write(`cwd=${path.relative(process.cwd(), path.resolve(cwd)) || "."}\ncommand=${command} ${args.join(" ")}\n`);
const child = spawn(command, args, { cwd, windowsHide: true, env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" }, stdio: ["ignore", "pipe", "pipe"] });
let lastOutput = Date.now();
let timedOut = false;
for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", chunk => { lastOutput = Date.now(); write(chunk); });
}
const timer = setInterval(() => {
  if (Date.now() - lastOutput < 180_000 || timedOut) return;
  timedOut = true;
  write("\nTIMEOUT: no output for 180 seconds; terminating this command tree.\n");
  if (process.platform === "win32") spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 15_000 });
  else child.kill("SIGKILL");
}, 1000);
child.on("error", error => write(`${error.message}\n`));
child.on("close", code => {
  clearInterval(timer);
  write(`\nexitCode=${timedOut ? 124 : code}\n`);
  process.exitCode = timedOut ? 124 : (code ?? 1);
});
