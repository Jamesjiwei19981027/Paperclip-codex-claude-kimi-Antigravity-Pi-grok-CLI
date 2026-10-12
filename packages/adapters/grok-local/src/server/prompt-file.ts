import fs from "node:fs/promises";
import path from "node:path";

export async function prepareGrokPromptFile(root: string, prompt: string) {
  const directory = await fs.mkdtemp(path.join(root, "paperclip-grok-prompt-"));
  const cleanup = () => fs.rm(directory, { recursive: true, force: true });
  try {
    const filename = path.join(directory, "task.txt");
    await fs.writeFile(filename, prompt, { encoding: "utf8", mode: 0o600 });
    return { args: ["--prompt-file", filename], cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
