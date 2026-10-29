import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { prepareClaudePromptBundle } from "./prompt-cache.js";
import type { PaperclipSkillEntry } from "@paperclipai/adapter-utils/server-utils";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

it.skipIf(process.platform !== "win32")("copies Windows skills without attempting a reparse point and hashes their contents", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "claude-skill-junction-")); roots.push(root);
  vi.stubEnv("PAPERCLIP_HOME", path.join(root, "cache"));
  const source = path.join(root, "source"); await fs.mkdir(source); await fs.writeFile(path.join(source, "SKILL.md"), "usable skill");
  const scripts = path.join(root, "scripts"); await fs.mkdir(scripts);
  await fs.writeFile(path.join(scripts, "helper.txt"), "nested skill content");
  await fs.symlink(scripts, path.join(source, "scripts"), "junction");
  const symlink = vi.spyOn(fs, "symlink").mockRejectedValue(Object.assign(new Error("symlink must not be attempted"), { code: "EPERM" }));
  const onLog = vi.fn();
  const skills = [{ key: "paperclipai/paperclip/paperclip", runtimeName: "paperclip", source }] as PaperclipSkillEntry[];
  const bundle = await prepareClaudePromptBundle({ companyId: "company", skills, instructionsContents: null, onLog });
  const target = path.join(bundle.addDir, ".claude/skills/paperclip");
  expect(await fs.readFile(path.join(target, "SKILL.md"), "utf8")).toBe("usable skill");
  expect((await fs.lstat(target)).isSymbolicLink()).toBe(false);
  expect((await fs.lstat(path.join(target, "scripts"))).isSymbolicLink()).toBe(false);
  expect(await fs.readFile(path.join(target, "scripts", "helper.txt"), "utf8")).toBe("nested skill content");
  expect(symlink).not.toHaveBeenCalled();
  expect(onLog).not.toHaveBeenCalled();

  const copy = vi.spyOn(fs, "cp");
  const reused = await prepareClaudePromptBundle({ companyId: "company", skills, instructionsContents: null, onLog });
  expect(reused.bundleKey).toBe(bundle.bundleKey);
  expect(copy).not.toHaveBeenCalled();

  await fs.writeFile(path.join(scripts, "helper.txt"), "changed nested skill");
  const changed = await prepareClaudePromptBundle({ companyId: "company", skills, instructionsContents: null, onLog });
  expect(changed.bundleKey).not.toBe(bundle.bundleKey);
  expect(await fs.readFile(path.join(changed.addDir, ".claude/skills/paperclip/scripts/helper.txt"), "utf8")).toBe("changed nested skill");
  expect(await fs.readFile(path.join(target, "scripts/helper.txt"), "utf8")).toBe("nested skill content");
  expect(symlink).not.toHaveBeenCalled();
  expect(onLog).not.toHaveBeenCalled();
});
