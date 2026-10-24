import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { prepareGrokPromptFile } from "./prompt-file.js";

it("preserves a prompt exceeding Windows argv limits without putting its contents in argv", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grok-prompt-test-"));
  const prompt = '完整任务\n"$ 不应执行"\n'.repeat(5000);
  try {
    const prepared = await prepareGrokPromptFile(root, prompt);
    expect(prepared.args[0]).toBe("--prompt-file");
    expect(prepared.args.join(" ").length).toBeLessThan(1000);
    expect(await fs.readFile(prepared.args[1], "utf8")).toBe(prompt);
    await prepared.cleanup();
    expect(await fs.readdir(root)).toEqual([]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
