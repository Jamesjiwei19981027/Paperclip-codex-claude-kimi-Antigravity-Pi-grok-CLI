import fs from "node:fs/promises";
import path from "node:path";

/** Keep full prompts out of Windows' shell command line. Pi accepts both files. */
export async function preparePiPromptFiles(root: string, systemPrompt: string, userPrompt: string) {
  const directory = await fs.mkdtemp(path.join(root, "paperclip-pi-prompt-"));
  const cleanup = () => fs.rm(directory, { recursive: true, force: true });
  try {
    const systemArg = path.join(directory, "system.txt");
    const userFile = path.join(directory, "task.txt");
    await fs.writeFile(systemArg, systemPrompt, { encoding: "utf8", mode: 0o600 });
    await fs.writeFile(userFile, userPrompt, { encoding: "utf8", mode: 0o600 });
    return { systemArg, userArg: `@${userFile}`, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
