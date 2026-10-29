import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Only translate the two Claude/CodeBuddy incompatibilities; argv never passes through cmd.exe. */
export async function translateCodeBuddyArgs(input: string[], model: string): Promise<{ args: string[]; stdinPrefix: string }> {
  if (/^claude-/i.test(model)) throw new Error("codebuddyModel 不能使用 claude-* 模型。");
  const args: string[] = [];
  let stdinPrefix = "";
  let sawModel = false;
  for (let i = 0; i < input.length; i++) {
    const arg = input[i];
    if (arg === "--append-system-prompt-file") {
      const file = input[++i];
      if (!file) throw new Error("缺少系统提示词文件。");
      const instructions = await readFile(file, "utf8");
      if (instructions.length > 20_000) stdinPrefix += `<agent-instructions>\n${instructions}\n</agent-instructions>\n\n`;
      else args.push("--append-system-prompt", instructions);
    } else if (arg === "--model" || arg.startsWith("--model=")) {
      if (arg === "--model" && !input[++i]) throw new Error("缺少模型名。");
      if (!sawModel && model) args.push("--model", model);
      sawModel = true;
    } else args.push(arg);
  }
  if (!sawModel && model) args.push("--model", model);
  return { args, stdinPrefix };
}

export async function writeCodeBuddyShim(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  const launcher = path.join(directory, "codebuddy-launcher.ts");
  const source = fileURLToPath(import.meta.url);
  if (path.resolve(launcher) !== path.resolve(source)) await copyFile(source, launcher);
  const shim = path.join(directory, "codebuddy.cmd");
  await writeFile(shim, [
    "@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0",
    'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ") ELSE (", '  SET "_prog=node.exe"', ")",
    '"%_prog%" "%dp0%\\codebuddy-launcher.ts" %*', "",
  ].join("\r\n"), "utf8");
  return shim;
}

async function main(): Promise<void> {
  const entry = process.env.PAPERCLIP_CODEBUDDY_ENTRY;
  if (!entry || !path.isAbsolute(entry)) throw new Error("CodeBuddy 入口未配置。");
  const { args, stdinPrefix } = await translateCodeBuddyArgs(process.argv.slice(2), process.env.PAPERCLIP_CODEBUDDY_MODEL ?? "");
  const env = { ...process.env };
  delete env.PAPERCLIP_CODEBUDDY_ENTRY;
  delete env.PAPERCLIP_CODEBUDDY_MODEL;
  // CodeBuddy only waits briefly for its first input. Upstream onSpawn must
  // persist the launcher's process identity before it can deliver the prompt.
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const child = spawn(process.execPath, [entry, ...args], { env, stdio: ["pipe", "inherit", "inherit"], windowsHide: true });
  child.stdin.on("error", () => {}); // CLI may exit before consuming the prompt.
  child.stdin.end(Buffer.concat([Buffer.from(stdinPrefix), ...chunks]));
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
  child.once("error", () => { console.error("无法启动 CodeBuddy，请检查入口与 Node 版本。"); process.exitCode = 1; });
  child.once("close", (code) => { process.exitCode = code ?? 1; });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void main().catch(() => { console.error("CodeBuddy 启动器配置无效，请检查 codebuddyEntry 与 codebuddyModel。"); process.exitCode = 1; });
}
