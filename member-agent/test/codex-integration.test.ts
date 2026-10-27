import { createServer } from "node:http";
import { once } from "node:events";
import { access, cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Logger } from "../src/logger.ts";
import { JobRunner } from "../src/job-runner.ts";
import { readCodexVersion } from "../src/codex-cli.ts";

const execFileAsync = promisify(execFile);
const CODEx_SOURCE = "D:\\paperclip\\node_modules\\.pnpm\\@openai+codex@0.160.0-win32-x64\\node_modules\\@openai\\codex\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe";
const temporaryRoots: string[] = [];
let lastJobResultDiagnostics: Record<string, unknown> | null = null;
async function tempDir() { const root = await mkdtemp(path.join(os.tmpdir(), "member-codex-integration-")); temporaryRoots.push(root); return root; }
async function cachedCodexExecutable(source: string): Promise<string> {
  // Keep this copied test executable outside per-run cleanup: Windows may keep
  // its image file locked briefly after exit, making immediate unlink flaky.
  const cacheRoot = path.join(os.tmpdir(), "paperclip-member-agent-codex-integration");
  await mkdir(cacheRoot, { recursive: true });
  const executable = path.join(cacheRoot, "codex-0.160.0.exe");
  try { await access(executable); }
  catch { await cp(source, executable); }
  const host = path.join(cacheRoot, "codex-code-mode-host.exe");
  try { await access(host); }
  catch { await cp(path.join(path.dirname(source), "codex-code-mode-host.exe"), host); }
  return executable;
}
afterEach(async () => {
  try {
    await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  } catch (error) {
    const issue = error as NodeJS.ErrnoException;
    console.error(`CODEX_INTEGRATION_CLEANUP_DIAGNOSTIC_BEGIN\n${JSON.stringify({
      cleanupError: { code: issue.code ?? null, message: issue.message },
      jobResult: lastJobResultDiagnostics,
    }, null, 2)}\nCODEX_INTEGRATION_CLEANUP_DIAGNOSTIC_END`);
    throw error;
  } finally {
    lastJobResultDiagnostics = null;
  }
});

async function runIntegration(useTools: boolean) {
    const source = CODEx_SOURCE;
    const root = await tempDir();
    const executable = await cachedCodexExecutable(source);
    await expect(readCodexVersion(executable)).resolves.toBe("0.160.0");

    const cwd = path.join(root, "workspace");
    const fileContent = `TOOL_FILE_CONTENT_${randomUUID()}`;
    const codexHome = path.join(root, "member-codex-home");
    const configDir = path.join(root, "agent-state");
    await Promise.all([mkdir(cwd), mkdir(codexHome), mkdir(configDir)]);
    // This nonce never enters the prompt or fake tool call; only a real file read can return it.
    await writeFile(path.join(cwd, "tool-input.txt"), fileContent);
    await execFileAsync("git", ["init", "--quiet"], { cwd, windowsHide: true });

    let requestCount = 0;
    const prompts: string[] = [];
    const toolOutputs: Array<Record<string, unknown>> = [];
    let advertisedCodeMode = false;
    const fakeModel = createServer(async (req, res) => {
      let bodyText = "";
      for await (const chunk of req) bodyText += chunk.toString();
      requestCount++;
      if (req.method !== "POST" || !req.url?.endsWith("/responses")) { res.writeHead(404); res.end(); return; }
      prompts.push(bodyText);
      const request = JSON.parse(bodyText);
      toolOutputs.push(...(Array.isArray(request.input) ? request.input.filter((item: Record<string, unknown>) => item.type === "custom_tool_call_output" && item.call_id === "call_read_fixture") : []));
      if (useTools && requestCount === 1) {
        advertisedCodeMode = request.tools?.some((tool: Record<string, unknown>) => tool.type === "custom" && tool.name === "exec") === true;
        const input = `const result = await tools.exec_command(${JSON.stringify({
          cmd: "Get-Content -LiteralPath './tool-input.txt'", workdir: cwd,
          shell: path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
          login: false, max_output_tokens: 1000,
        })}); text(result);`;
        const call = { id: "ctc_fixture", type: "custom_tool_call", call_id: "call_read_fixture", name: "exec", input, status: "completed" };
        const result = { id: "resp_tool", object: "response", status: "completed", model: request.model, output: [call], usage: { input_tokens: 17, output_tokens: 4, total_tokens: 21 } };
        res.writeHead(200, { "content-type": "text/event-stream" });
        const emit = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        emit("response.created", { response: { ...result, status: "in_progress", output: [] } });
        emit("response.output_item.added", { output_index: 0, item: { ...call, status: "in_progress", input: "" } });
        emit("response.custom_tool_call_input.delta", { item_id: call.id, output_index: 0, delta: input });
        emit("response.custom_tool_call_input.done", { item_id: call.id, output_index: 0, input });
        emit("response.output_item.done", { output_index: 0, item: call });
        emit("response.completed", { response: result });
        res.end();
        return;
      }
      const message = { id: "msg_phase3", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "MEMBER_AGENT_PHASE3_INTEGRATION_OK", annotations: [] }] };
      const result = { id: `resp_phase3_${requestCount}`, object: "response", created_at: 1700000000, status: "completed", model: request.model, output: [message], usage: { input_tokens: 17, output_tokens: 4, total_tokens: 21, input_tokens_details: { cached_tokens: 0 } } };
      res.writeHead(200, { "content-type": "text/event-stream" });
      const event = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      event("response.created", { response: { ...result, status: "in_progress", output: [] } });
      event("response.output_item.added", { output_index: 0, item: { ...message, status: "in_progress", content: [] } });
      event("response.content_part.added", { item_id: message.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
      event("response.output_text.delta", { item_id: message.id, output_index: 0, content_index: 0, delta: "MEMBER_AGENT_PHASE3_INTEGRATION_OK" });
      event("response.output_text.done", { item_id: message.id, output_index: 0, content_index: 0, text: "MEMBER_AGENT_PHASE3_INTEGRATION_OK" });
      event("response.output_item.done", { output_index: 0, item: message });
      event("response.completed", { response: result });
      res.end();
    });
    fakeModel.listen(0, "127.0.0.1"); await once(fakeModel, "listening");
    const address = fakeModel.address(); if (!address || typeof address === "string") throw new Error("fake model failed to bind loopback");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    await writeFile(path.join(codexHome, "config.toml"), [
      'model = "gpt-5.4"', 'model_provider = "phase3_fake"', "[model_providers.phase3_fake]", 'name = "phase3 loopback fake"',
      `base_url = "${baseUrl}/v1"`, 'wire_api = "responses"', "requires_openai_auth = false", "request_max_retries = 0", "stream_max_retries = 0",
      ...(useTools ? ["[features]", "code_mode = true", "code_mode_host = true", "code_mode_only = true"] : []),
    ].join("\n"));

    const logDir = path.join(root, "logs"); const logger = new Logger(logDir, ["FAKE-long-lived-key", "FAKE-run-token", "FAKE-tool-token"], () => undefined);
    const frames: Array<Record<string, any>> = [];
    const runner = new JobRunner({
      serverUrl: baseUrl, logger, send: (frame) => frames.push(frame as Record<string, any>),
      executorUrl: new URL("../src/executors/codex.ts", import.meta.url),
      executorData: { codexExecutable: executable, codexHome, runtimeDir: path.resolve("runtime"), projectDirs: { "FAKE-project-id": cwd }, defaultCwd: "", configDir },
    });
    const job = {
      v: 1, type: "job.start", jobId: "FAKE-phase3-run-id", companyId: "FAKE-company-id",
      agent: { id: "FAKE-agent-id", name: "Phase 3 Integration" }, authToken: "FAKE-run-token",
      context: { projectId: "FAKE-project-id", paperclipWorkspace: { projectId: "FAKE-project-id", cwd: "Z:\\server\\workspace", source: "project_primary" }, paperclipTaskMarkdown: useTools ? "Read tool-input.txt in the work directory using a tool, then reply MEMBER_AGENT_PHASE3_INTEGRATION_OK." : "Reply exactly MEMBER_AGENT_PHASE3_INTEGRATION_OK. Do not use tools." },
      config: { maxRunSec: 60 }, runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null }, runtimeTools: null,
      handoffMarkdown: "", codeSyncDir: "",
    };
    try {
      runner.start(job as any);
      for (let attempt = 0; attempt < 900 && !frames.some((frame) => frame.type === "job.result"); attempt++) await new Promise((resolve) => setTimeout(resolve, 100));
      const result = frames.find((frame) => frame.type === "job.result");
      expect(result, "Codex job should reach one terminal protocol result").toBeDefined();
      const recentLogs = frames
        .filter((frame) => frame.type === "job.log")
        .slice(-8)
        .map((frame) => ({ stream: frame.stream, chunk: frame.chunk }));
      const failureDiagnostics = {
        errorCode: result?.errorCode ?? null,
        errorMessage: result?.errorMessage ?? null,
        summary: result?.summary ?? null,
        recentJobLogs: recentLogs,
      };
      lastJobResultDiagnostics = {
        exitCode: result?.exitCode ?? null,
        timedOut: result?.timedOut ?? null,
        ...failureDiagnostics,
      };
      if (result && (result.exitCode !== 0 || result.timedOut !== false)) {
        console.error(`CODEX_INTEGRATION_DIAGNOSTIC_BEGIN\n${JSON.stringify(failureDiagnostics, null, 2)}\nCODEX_INTEGRATION_DIAGNOSTIC_END`);
      }
      expect(result, `Codex integration failure diagnostics (job.result and redacted job.log frames):\n${JSON.stringify(failureDiagnostics, null, 2)}`)
        .toMatchObject({ exitCode: 0, timedOut: false });
      expect(frames.filter((frame) => frame.type === "job.result")).toHaveLength(1);
      expect(frames.some((frame) => frame.type === "job.accepted")).toBe(true);
      expect(frames.some((frame) => frame.type === "job.log" && /MEMBER_AGENT_PHASE3_INTEGRATION_OK/.test(String(frame.chunk)))).toBe(true);
      expect(frames.some((frame) => frame.type === "job.meta")).toBe(true);
      expect(frames.some((frame) => frame.type === "job.usage")).toBe(true);
      expect(requestCount).toBeGreaterThan(0);
      expect(prompts.some((prompt) => /paperclip/i.test(prompt))).toBe(true);
      expect(prompts.every(prompt => prompt.includes("没有 Paperclip 原生工具"))).toBe(true);
      expect(prompts[0]).toContain("PAPERCLIP_API_URL");
      expect(prompts[0]).toContain("X-Paperclip-Run-Id");
      expect(prompts[0]).not.toContain("FAKE-run-token");
      expect(prompts[0]).not.toContain("FAKE-long-lived-key");
      if (useTools) {
        expect(advertisedCodeMode, "the real Codex must advertise its code-mode exec tool").toBe(true);
        expect(requestCount, "Codex must send the tool result back to the model").toBe(2);
        expect(toolOutputs, "one real code-mode tool result must return to the fake model").toHaveLength(1);
        const output = JSON.stringify(toolOutputs[0].output);
        expect(output, `code-mode tool output: ${output}`).toContain(fileContent);
        expect(output).toMatch(/(?:Process exited with code 0|exit_code[\\"\s:]+0)/);
        console.info("CODE_MODE_TOOL_ROUNDTRIP_OK fileNonceMatched=true toolOutputs=1 modelRequests=2");
      }
      const authPath = path.join(codexHome, "auth.json");
      expect(frames.some((frame) => JSON.stringify(frame).includes(authPath))).toBe(false);
    } finally {
      await runner.shutdown();
      await new Promise<void>((resolve) => fakeModel.close(() => resolve()));
    }
}

describe("Codex end-to-end adapter integration", () => {
  it.skipIf(process.platform !== "win32")("uses the packaged adapter, real Codex 0.160.0 and a loopback fake model without credentials", () => runIntegration(false), 120_000);
  it.skipIf(process.platform !== "win32")("executes a real code-mode file read and returns its output to the loopback fake model without credentials", () => runIntegration(true), 120_000);
});
