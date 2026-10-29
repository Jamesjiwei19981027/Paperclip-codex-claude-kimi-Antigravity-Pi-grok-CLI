import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { buildCodeBuddyLoginEnvironment } from "../../../member-agent/src/codebuddy-cli.ts";
import { resolveCodexProxy } from "../../../member-agent/src/executors/codex-proxy.ts";

const evidence = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve("member-agent/dist-installer/PaperclipMemberAgent-0.3.1-codebuddy/app");
const scratch = await fs.mkdtemp(path.join(tmpdir(), "pma031-smoke-"));
const env = buildCodeBuddyLoginEnvironment(process.env, path.join(scratch, "config"));
const proxy = await resolveCodexProxy({ env: process.env, serverUrl: "http://127.0.0.1:3100", warn: message => console.log(message) });
Object.assign(env, proxy.env, { PAPERCLIP_CODEBUDDY_ENTRY: path.join(pkg, "codebuddy/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy") });
const started = performance.now();
const child = spawn(path.join(pkg, "node/node.exe"), [path.join(pkg, "member-agent/src/executors/codebuddy-launcher.ts"), "--print", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"], { cwd: scratch, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
let stdout = "", stderr = "";
child.stdout.on("data", chunk => stdout += chunk); child.stderr.on("data", chunk => stderr += chunk);
child.stdin.on("error", () => {});
const delayed = setTimeout(() => { console.log(`stdin_delay_ms=${Math.round(performance.now() - started)}`); child.stdin.end("只回复你好"); }, 5000);
const deadline = setTimeout(() => child.kill(), 120000);
try {
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  await fs.writeFile(path.join(evidence, "smoke-stdout.jsonl"), stdout);
  await fs.writeFile(path.join(evidence, "smoke-stderr.txt"), stderr);
  const resultLine = stdout.split(/\r?\n/).find(line => { try { return JSON.parse(line).type === "result"; } catch { return false; } });
  console.log(`exitCode=${code}; elapsed_ms=${Math.round(performance.now() - started)}`);
  console.log(resultLine ?? "MISSING_RESULT");
  if (code !== 0 || !resultLine || !JSON.parse(resultLine).result?.trim()) process.exitCode = 1;
} finally { clearTimeout(delayed); clearTimeout(deadline); await fs.rm(scratch, { recursive: true, force: true }); }
