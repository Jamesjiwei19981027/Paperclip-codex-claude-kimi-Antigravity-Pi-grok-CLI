import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { JobRunner } from "../../../member-agent/src/job-runner.ts";
import { Logger } from "../../../member-agent/src/logger.ts";
const root = await fs.mkdtemp(path.join(tmpdir(), "cb032-log-"));
const visible = [];
let resolveResult;
const done = new Promise(resolve => { resolveResult = resolve; });
const runner = new JobRunner({ serverUrl: "http://127.0.0.1:1", logger: new Logger(root, [], line => visible.push(line)),
  executorUrl: new URL("../../../member-agent/test/fixtures/executor.ts", import.meta.url), executorData: { mode: "error-code" },
  send: frame => { if (frame.type === "job.result") resolveResult(frame); },
});
try {
  runner.start({ v: 1, type: "job.start", jobId: "fixture-log", companyId: "fixture-company", agent: { id: "fixture-agent", name: "Fixture" },
    authToken: "FAKE-LOG-TOKEN", context: {}, config: { maxRunSec: 5 }, runtime: {}, runtimeTools: null, handoffMarkdown: "", codeSyncDir: "" });
  const result = await done;
  const log = visible.find(line => line.includes("任务结束 fixture-log："));
  console.log(log); console.log(JSON.stringify(result));
  assert.ok(log.includes("失败（member_agent_codebuddy_login_required）"));
  assert.equal(result.exitCode, 0); assert.equal(result.errorCode, "member_agent_codebuddy_login_required");
} finally { await runner.shutdown(); await fs.rm(root, { recursive: true, force: true }); }
