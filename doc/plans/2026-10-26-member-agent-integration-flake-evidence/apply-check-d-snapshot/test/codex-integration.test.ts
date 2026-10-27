import { createServer } from "node:http";
import { once } from "node:events";
import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { Logger } from "../src/logger.ts";
import { JobRunner } from "../src/job-runner.ts";
import { readCodexVersion } from "../src/codex-cli.ts";

const execFileAsync = promisify(execFile);
const CODEx_SOURCE = "D:\\paperclip\\node_modules\\.pnpm\\@openai+codex@0.160.0-win32-x64\\node_modules\\@openai\\codex\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe";
const temporaryRoots: string[] = [];
async function tempDir() { const root = await mkdtemp(path.join(os.tmpdir(), "member-codex-integration-")); temporaryRoots.push(root); return root; }
afterEach(async () => { await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("Codex end-to-end adapter integration", () => {
  it.skipIf(process.platform !== "win32")("uses the packaged adapter, real Codex 0.160.0 and a loopback fake model without credentials", async () => {
    const source = CODEx_SOURCE;
    const root = await tempDir();
    const executable = path.join(root, "codex-0.160.0.exe");
    await cp(source, executable);
    await expect(readCodexVersion(executable)).resolves.toBe("0.160.0");

    const cwd = path.join(root, "workspace");
    const codexHome = path.join(root, "member-codex-home");
    const configDir = path.join(root, "agent-state");
    await Promise.all([mkdir(cwd), mkdir(codexHome), mkdir(configDir)]);
    await execFileAsync("git", ["init", "--quiet"], { cwd, windowsHide: true });

    let requestCount = 0;
    const prompts: string[] = [];
    const fakeModel = createServer(async (req, res) => {
      let bodyText = "";
      for await (const chunk of req) bodyText += chunk.toString();
      requestCount++;
      if (req.method !== "POST" || !req.url?.endsWith("/responses")) { res.writeHead(404); res.end(); return; }
      prompts.push(bodyText);
      const request = JSON.parse(bodyText);
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
      context: { projectId: "FAKE-project-id", paperclipWorkspace: { projectId: "FAKE-project-id", cwd: "Z:\\server\\workspace", source: "project_primary" }, paperclipTaskMarkdown: "Reply exactly MEMBER_AGENT_PHASE3_INTEGRATION_OK. Do not use tools." },
      config: { maxRunSec: 60 }, runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null }, runtimeTools: null,
      handoffMarkdown: "", codeSyncDir: "",
    };
    try {
      runner.start(job as any);
      for (let attempt = 0; attempt < 900 && !frames.some((frame) => frame.type === "job.result"); attempt++) await new Promise((resolve) => setTimeout(resolve, 100));
      const result = frames.find((frame) => frame.type === "job.result");
      expect(result, "Codex job should reach one terminal protocol result").toBeDefined();
      expect(result).toMatchObject({ exitCode: 0, timedOut: false });
      expect(frames.filter((frame) => frame.type === "job.result")).toHaveLength(1);
      expect(frames.some((frame) => frame.type === "job.accepted")).toBe(true);
      expect(frames.some((frame) => frame.type === "job.log" && /MEMBER_AGENT_PHASE3_INTEGRATION_OK/.test(String(frame.chunk)))).toBe(true);
      expect(frames.some((frame) => frame.type === "job.meta")).toBe(true);
      expect(frames.some((frame) => frame.type === "job.usage")).toBe(true);
      expect(requestCount).toBeGreaterThan(0);
      expect(prompts.some((prompt) => /paperclip/i.test(prompt))).toBe(true);
      const authPath = path.join(codexHome, "auth.json");
      expect(frames.some((frame) => JSON.stringify(frame).includes(authPath))).toBe(false);
    } finally {
      await runner.shutdown();
      await new Promise<void>((resolve) => fakeModel.close(() => resolve()));
    }
  }, 120_000);
});
