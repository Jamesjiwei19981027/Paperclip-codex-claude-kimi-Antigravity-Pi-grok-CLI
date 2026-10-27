import { afterEach, describe, expect, it, vi } from "vitest";
import { cp, lstat, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { localizeContext, materializeSkills, rebaseEndpoint, resolveLocalCwd } from "../src/executors/codex-support.ts";

const roots: string[] = [];
async function tempDir() { const root = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(path.join(os.tmpdir(), "paperclip-codex-support-"))); roots.push(root); return root; }
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("Codex workspace localization", () => {
  it("prefers workspace project id then context project id and uses the configured default only if unmapped", async () => {
    const root = await tempDir();
    const project = path.join(root, "project");
    await mkdir(project);
    const base = { projectDirs: { "context-project": project }, defaultCwd: "", configDir: path.join(root, "agent"), codexHome: path.join(root, "codex"), runtimeDir: path.join(root, "runtime") };
    expect(await resolveLocalCwd({ projectId: "context-project" }, base)).toEqual({ projectId: "context-project", cwd: project });
    expect(await resolveLocalCwd({ projectId: "context-project", paperclipWorkspace: { projectId: "missing-project" } }, { ...base, defaultCwd: project })).toEqual({ projectId: "missing-project", cwd: project });
    expect(await resolveLocalCwd({}, { ...base, defaultCwd: project })).toEqual({ projectId: "", cwd: project });
  });

  it("rejects directories under Codex home or runtime and rejects a file as cwd", async () => {
    const root = await tempDir();
    const project = path.join(root, "project");
    const codexHome = path.join(root, "codex");
    const runtimeDir = path.join(root, "runtime");
    await Promise.all([mkdir(project), mkdir(codexHome), mkdir(runtimeDir)]);
    const config = { projectDirs: { p: project }, defaultCwd: "", configDir: path.join(root, "agent"), codexHome, runtimeDir };
    await expect(resolveLocalCwd({ projectId: "p" }, { ...config, projectDirs: { p: codexHome } })).rejects.toMatchObject({ code: "member_agent_cwd_unresolved" });
    await expect(resolveLocalCwd({ projectId: "p" }, { ...config, projectDirs: { p: runtimeDir } })).rejects.toMatchObject({ code: "member_agent_cwd_unresolved" });
    const file = path.join(root, "not-a-dir"); await writeFile(file, "x");
    await expect(resolveLocalCwd({ projectId: "p" }, { ...config, projectDirs: { p: file } })).rejects.toMatchObject({ code: "member_agent_cwd_missing" });
  });

  it("rejects a project directory whose symlink resolves inside CODEX_HOME", async () => {
    const root = await tempDir();
    const alias = path.join(root, "project-alias");
    const codexHome = path.join(root, "private-codex-home");
    await mkdir(alias); await mkdir(codexHome);
    await expect(resolveLocalCwd({ projectId: "p" }, {
      projectDirs: { p: alias }, defaultCwd: "", configDir: path.join(root, "agent"), codexHome, runtimeDir: path.join(root, "runtime"),
    }, {
      stat: async () => ({ isDirectory: () => true } as Awaited<ReturnType<typeof stat>>),
      realpath: async (candidate: string) => path.resolve(candidate) === path.resolve(alias) ? codexHome : path.resolve(candidate),
    })).rejects.toMatchObject({ code: "member_agent_cwd_unresolved" });
  });

  it("rewrites only local workspace fields and counts suspicious server paths without changing task text", () => {
    const input = { paperclipWorkspaces: [{ cwd: "D:\\paperclip\\server" }], paperclipWorkspace: { cwd: "D:\\paperclip\\server", worktreePath: "D:\\paperclip\\tree", source: "agent_home", projectId: "p" }, paperclipTaskMarkdown: "Read D:\\paperclip\\README.md", paperclipSessionHandoffMarkdown: "old" };
    const result = localizeContext(input, "E:\\project", "C:\\Users\\test\\AppData\\paperclip\\agents\\a\\home");
    expect(result.context.paperclipWorkspaces).toBeUndefined();
    expect(result.context.paperclipTaskMarkdown).toBe(input.paperclipTaskMarkdown);
    expect(result.context.paperclipSessionHandoffMarkdown).toBeUndefined();
    expect(result.context.paperclipWorkspace).toEqual({ cwd: "E:\\project", source: "agent_home", projectId: "p", agentHome: "C:\\Users\\test\\AppData\\paperclip\\agents\\a\\home" });
    expect(result.suspectedServerPaths).toBe(1);
  });

  it("rebases host, protocol, and port to the configured Paperclip origin", () => {
    expect(rebaseEndpoint("http://localhost:3100/api/tools?x=1", "https://board.example")).toBe("https://board.example/api/tools?x=1");
    expect(rebaseEndpoint("http://internal:3100/api/tools", "http://192.168.1.5:4100")).toBe("http://192.168.1.5:4100/api/tools");
  });
});

describe("materialized bundled skills", () => {
  it("copies a missing skill, skips matching content, and atomically replaces changed content", async () => {
    const root = await tempDir();
    const runtime = path.join(root, "runtime");
    const home = path.join(root, "codex-home");
    const source = path.join(runtime, "skills", "paperclip");
    const target = path.join(home, "skills", "paperclip");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "SKILL.md"), "v1");
    await materializeSkills(runtime, home);
    expect(await readFile(path.join(target, "SKILL.md"), "utf8")).toBe("v1");
    let renameCalls = 0;
    const instrumentedFs = { lstat, mkdir, readFile, readdir, rm, cp, symlink, rename: async (from: string, to: string) => { renameCalls++; return rename(from, to); } };
    await materializeSkills(runtime, home, instrumentedFs);
    expect(renameCalls).toBe(0);
    await writeFile(path.join(source, "SKILL.md"), "v2");
    await materializeSkills(runtime, home, instrumentedFs);
    expect(await readFile(path.join(target, "SKILL.md"), "utf8")).toBe("v2");
    expect(renameCalls).toBeGreaterThan(0);
  });

  it("replaces a symlink with a real directory and never creates links (EPERM stub)", async () => {
    const root = await tempDir();
    const runtime = path.join(root, "runtime");
    const home = path.join(root, "codex-home");
    const source = path.join(runtime, "skills", "paperclip");
    const target = path.join(home, "skills", "paperclip");
    const linked = path.join(root, "linked");
    await mkdir(source, { recursive: true }); await writeFile(path.join(source, "SKILL.md"), "bundled");
    await mkdir(linked); await writeFile(path.join(linked, "SKILL.md"), "stale");
    await mkdir(path.dirname(target), { recursive: true });
    let linkCreated = true;
    try { await symlink(linked, target, "junction"); }
    catch (error) {
      linkCreated = false;
      if ((error as NodeJS.ErrnoException).code !== "EPERM" && (error as NodeJS.ErrnoException).code !== "EACCES") throw error;
      // Simulate the already-present link with an ordinary directory and a
      // lstat substitute, so this replacement branch is tested even when the
      // host has no privilege to create links.
      await mkdir(target, { recursive: true });
      await writeFile(path.join(target, "SKILL.md"), "stale link target");
    }

    let linkAttempted = false;
    const inspect = async (candidate: string) => {
      const value = await lstat(candidate);
      if (!linkCreated && path.resolve(candidate) === path.resolve(target)) {
        return Object.assign(Object.create(Object.getPrototypeOf(value)) as typeof value, { isSymbolicLink: () => true, isDirectory: () => false });
      }
      return value;
    };
    const fakeFs = { lstat: inspect, mkdir, readFile, readdir, rename, rm, cp, symlink: async () => { linkAttempted = true; throw Object.assign(new Error("no symlink permission"), { code: "EPERM" }); } };
    await materializeSkills(runtime, home, fakeFs);
    expect(linkAttempted).toBe(false);
    expect(await readFile(path.join(target, "SKILL.md"), "utf8")).toBe("bundled");
    expect((await lstat(target)).isSymbolicLink()).toBe(false);
  });

  it("fails closed when a skill cannot be copied", async () => {
    const root = await tempDir();
    const runtime = path.join(root, "runtime");
    const home = path.join(root, "codex-home");
    const source = path.join(runtime, "skills", "paperclip");
    await mkdir(source, { recursive: true }); await writeFile(path.join(source, "SKILL.md"), "bundled");
    const failureFs = { lstat, mkdir, readFile, readdir, rename, rm, symlink, cp: async () => { throw new Error("disk failure"); } };
    await expect(materializeSkills(runtime, home, failureFs)).rejects.toThrow();
  });
});
