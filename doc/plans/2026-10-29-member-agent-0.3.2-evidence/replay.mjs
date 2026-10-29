// Run from the repository root. Synthetic CLI output; real bundled claude_local execution.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createCodeBuddyExecutor } from "../../../member-agent/src/executors/codebuddy.ts";
import { validateResult } from "../../../member-agent/src/protocol.ts";

const root = await fs.mkdtemp(path.join(tmpdir(), "cb032-replay-"));
try {
  const stdout = await fs.readFile("member-agent/test/fixtures/codebuddy-read-skill-success.jsonl", "utf8");
  const entry = path.join(root, "replay.mjs");
  await fs.writeFile(entry, `if(process.argv.includes('--version')){console.log('2.169.0')}else{process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(stdout)}))}`);
  const cwd = path.join(root, "project"); await fs.mkdir(cwd);
  let raw;
  const result = await createCodeBuddyExecutor({ codebuddyEntry: entry, codebuddyHome: path.join(root, "home"),
    runtimeDir: path.resolve("member-agent/runtime"), projectDirs: {}, defaultCwd: cwd, configDir: path.join(root, "state") }, {
    processEnv: { ...process.env }, queryRegistry: async () => "",
    loadRuntime: async runtimeEntry => {
      const { execute } = await import(pathToFileURL(runtimeEntry).href);
      return { execute: async ctx => { raw = await execute(ctx); return raw; } };
    },
  }).execute({ job: { v: 1, type: "job.start", jobId: "fixture-run", companyId: "fixture-company",
    agent: { id: "fixture-agent", name: "Replay" }, authToken: "FAKE-REPLAY-TOKEN", context: { paperclipTaskMarkdown: "读取技能并完成任务" },
    runtime: {}, config: { maxRunSec: 30 }, runtimeTools: null, handoffMarkdown: "", codeSyncDir: "" },
    serverUrl: "http://localhost:3100", signal: new AbortController().signal,
    log: () => {}, event: () => {}, meta: () => {}, usage: () => {}, childSpawned: () => {},
  });
  console.log(`claude_local=${JSON.stringify({ exitCode: raw?.exitCode, errorCode: raw?.errorCode, resultJson: raw?.resultJson })}`);
  console.log(`normalized=${JSON.stringify(result)}`);
  assert.equal(raw.errorCode, "claude_auth_required");
  assert.equal(result.exitCode, 0);
  assert.equal(Object.hasOwn(result, "errorCode"), false);
  validateResult(result);
  console.log("回放断言通过：复用运行时保留原误判；成员归一化后 exitCode=0 且无 errorCode。");
} finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); }
