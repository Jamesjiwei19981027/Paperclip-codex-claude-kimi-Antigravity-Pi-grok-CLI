import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { translateCodeBuddyArgs, writeCodeBuddyShim } from "../src/executors/codebuddy-launcher.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() { const root = await mkdtemp(path.join(tmpdir(), "成员-cb-launcher-")); roots.push(root); return root; }

it("waits for stdin end before launching a CLI with a short input deadline", async () => {
  const root = await fixture(); const entry = path.join(root, "fake.mjs");
  const instructions = path.join(root, "instructions.txt"); const text = "字".repeat(20001);
  await writeFile(instructions, text);
  await writeFile(entry, `const chunks=[];const deadline=setTimeout(()=>process.exit(9),1500);process.stdin.on('data',c=>chunks.push(c));process.stdin.on('end',()=>{clearTimeout(deadline);process.stdout.write(Buffer.concat(chunks));process.exitCode=7});`);
  const child = spawn(process.execPath, [path.resolve("src/executors/codebuddy-launcher.ts"), "--print", "--append-system-prompt-file", instructions], {
    env: { ...process.env, PAPERCLIP_CODEBUDDY_ENTRY: entry }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  child.stdin.on("error", () => {});
  let stdout = ""; let stderr = ""; child.stdout.on("data", c => stdout += c); child.stderr.on("data", c => stderr += c);
  const closed = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  const delay = setTimeout(() => { const bytes = Buffer.from("只回复你好\n第二行"); child.stdin.write(bytes.subarray(0, 2)); child.stdin.end(bytes.subarray(2)); }, 5000);
  try {
    expect(await closed, stderr).toBe(7);
    expect(stdout).toBe(`<agent-instructions>\n${text}\n</agent-instructions>\n\n只回复你好\n第二行`);
  } finally { clearTimeout(delay); child.kill(); }
}, 15000);

it("converts multiline instruction files without cmd escaping and replaces Claude models", async () => {
  const root = await fixture(); const file = path.join(root, "instructions.txt");
  await writeFile(file, "第一行\n$env:KEY `literal` $(literal) & second");
  expect(await translateCodeBuddyArgs(["--print", "--append-system-prompt-file", file, "--model", "claude-opus-5", "--resume", "session"], "deepseek-v4.1-flash"))
    .toEqual({ args: ["--print", "--append-system-prompt", "第一行\n$env:KEY `literal` $(literal) & second", "--model", "deepseek-v4.1-flash", "--resume", "session"], stdinPrefix: "" });
});
it("omits all Claude models when account default is selected", async () => {
  expect((await translateCodeBuddyArgs(["--model=claude-opus-5", "--verbose"], "")).args).toEqual(["--verbose"]);
  await expect(translateCodeBuddyArgs([], "claude-sonnet-5")).rejects.toThrow(/codebuddyModel/);
});
it("moves instructions longer than 20000 characters into stdin", async () => {
  const root = await fixture(); const file = path.join(root, "long.txt"); await writeFile(file, "字".repeat(20001));
  const result = await translateCodeBuddyArgs(["--append-system-prompt-file", file], "");
  expect(result.args).toEqual([]); expect(result.stdinPrefix).toBe(`<agent-instructions>\n${"字".repeat(20001)}\n</agent-instructions>\n\n`);
});
it("writes an npm-standard shim whose script is adjacent and uses node.exe", async () => {
  const root = await fixture(); const shim = await writeCodeBuddyShim(root);
  const text = await readFile(shim, "utf8");
  expect(text).toContain('"%dp0%\\codebuddy-launcher.ts" %*');
  expect(text).toContain('"%dp0%\\node.exe"');
  expect(await readFile(path.join(root, "codebuddy-launcher.ts"), "utf8")).toContain("translateCodeBuddyArgs");
});
