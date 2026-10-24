import fs from "node:fs/promises";
import path from "node:path";

/**
 * Prompts at or below this length stay inline in `--prompt`. Windows caps a
 * whole command line at 32,767 UTF-16 units, and quoting adds a backslash
 * before every `"` in the prompt, so this leaves headroom for the other
 * arguments.
 */
export const GEMINI_INLINE_PROMPT_MAX_CHARS = 24_000;

export const GEMINI_PROMPT_FILE_END_MARKER = "END OF PAPERCLIP PROMPT";

/**
 * Neither the Gemini nor the Antigravity CLI reads a plain-text prompt from
 * stdin in print mode, so a prompt too long for argv is saved to a file and
 * `--prompt` asks the agent to read it first.
 */
export async function prepareGeminiPromptFile(root: string, prompt: string) {
  const directory = await fs.mkdtemp(path.join(root, "paperclip-gemini-prompt-"));
  const cleanup = () => fs.rm(directory, { recursive: true, force: true });
  try {
    const filename = path.join(directory, "prompt.md");
    await fs.writeFile(filename, `${prompt}\n\n${GEMINI_PROMPT_FILE_END_MARKER}\n`, { encoding: "utf8", mode: 0o600 });
    const inlinePrompt = [
      "The full Paperclip prompt for this run is too long for the Windows command line, so it was saved to a file.",
      `Before doing anything else, read the entire file ${filename} (${prompt.length} characters, UTF-8) with your file-reading tool.`,
      `If the reader truncates or pages the output, keep reading until you reach the line "${GEMINI_PROMPT_FILE_END_MARKER}".`,
      "Then follow the file's contents exactly as if they had been sent as this prompt.",
    ].join("\n");
    return { directory, filename, inlinePrompt, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
