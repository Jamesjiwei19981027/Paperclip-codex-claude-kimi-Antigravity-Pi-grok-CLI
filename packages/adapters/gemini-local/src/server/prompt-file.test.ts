import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import {
  GEMINI_INLINE_PROMPT_MAX_CHARS,
  GEMINI_PROMPT_FILE_END_MARKER,
  prepareGeminiPromptFile,
} from "./prompt-file.js";

it("moves a prompt exceeding Windows argv limits into a file that --prompt points to", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gemini-prompt-test-"));
  const prompt = '完整任务\n"$ 不应执行"\n'.repeat(5000);
  expect(prompt.length).toBeGreaterThan(GEMINI_INLINE_PROMPT_MAX_CHARS);
  try {
    const prepared = await prepareGeminiPromptFile(root, prompt);
    expect(prepared.inlinePrompt.length).toBeLessThan(1000);
    expect(prepared.inlinePrompt).toContain(prepared.filename);
    expect(prepared.inlinePrompt).toContain(GEMINI_PROMPT_FILE_END_MARKER);
    expect(path.dirname(prepared.filename)).toBe(prepared.directory);
    expect(await fs.readFile(prepared.filename, "utf8")).toBe(`${prompt}\n\n${GEMINI_PROMPT_FILE_END_MARKER}\n`);
    await prepared.cleanup();
    expect(await fs.readdir(root)).toEqual([]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
