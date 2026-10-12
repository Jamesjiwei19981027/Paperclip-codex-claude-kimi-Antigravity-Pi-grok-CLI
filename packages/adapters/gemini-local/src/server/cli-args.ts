import { DEFAULT_GEMINI_LOCAL_MODEL } from "../index.js";

export type GeminiCliFlavor = "gemini" | "antigravity";

export function resolveGeminiCliFlavor(value: unknown): GeminiCliFlavor {
  return value === "antigravity" ? "antigravity" : "gemini";
}

export function buildGeminiCliArgs(input: {
  flavor: GeminiCliFlavor;
  model: string;
  sandbox: boolean;
  extraArgs: string[];
  resumeSessionId: string | null;
  prompt: string;
  cwd: string;
}): string[] {
  const args = ["--output-format", "stream-json"];
  if (input.resumeSessionId) {
    args.push(input.flavor === "antigravity" ? "--conversation" : "--resume", input.resumeSessionId);
  }
  if (input.model && input.model !== DEFAULT_GEMINI_LOCAL_MODEL) {
    args.push("--model", input.model);
  }

  if (input.flavor === "antigravity") {
    if (input.sandbox) args.push("--sandbox");
    else args.push("--dangerously-skip-permissions");
    args.push("--print-timeout", "0", "--add-dir", input.cwd);
  } else {
    args.push("--approval-mode", "yolo");
    args.push(input.sandbox ? "--sandbox" : "--sandbox=none");
  }

  if (input.extraArgs.length > 0) args.push(...input.extraArgs);
  args.push("--prompt", input.prompt);
  return args;
}
