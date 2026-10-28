import { afterEach, describe, expect, it, vi } from "vitest";
import { cp, lstat, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { localizeContext, materializeSkills, rebaseEndpoint, resolveLocalCwd } from "../src/executors/codex-support.ts";

const roots: string[] = [];
async function tempDir() { const root = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(path.join(os.tmpdir(), "paperclip-codex-support-"))); roots.push(root); return root; }
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("Codex workspace localization", () => {
  describe.each([false, true])("actionable cwd diagnostics (project id provided: %s)", (withProjectId) => {
    const context = withProjectId ? { projectId: "local-project" } : {};
    function config(root: string, cwd: string) {
      return { projectDirs: withProjectId ? { "local-project": cwd } : {}, defaultCwd: cwd,
        configDir: path.join(root, "agent"), codexHome: path.join(root, "codex"), runtimeDir: path.join(root, "runtime") };
    }
    function descriptor(cwd: string) {
      return withProjectId ? `项目 local-project 的本机目录 ${cwd}` : `默认工作目录 ${cwd}（安装时填写）`;
    }
    async function expectDiagnostic(promise: Promise<unknown>, cwd: string, code: string, reason: string) {
      await expect(promise).rejects.toMatchObject({ code, message: expect.stringContaining(descriptor(cwd)) });
      await expect(promise).rejects.toThrow(reason);
      if (!withProjectId) await expect(promise).rejects.not.toThrow("未提供编号");
    }

    it.each([
      ["parent segment", "project/../other", ".. 路径段"],
      ["UNC path", "\\\\server\\share\\repo", "UNC"],
      ["relative path", "relative-project", "绝对路径"],
    ])("names the configured path for %s", async (_name, cwd, reason) => {
      const root = await tempDir();
      await expectDiagnostic(resolveLocalCwd(context, config(root, cwd)), cwd, "member_agent_cwd_unresolved", reason);
    });

    it("describes a missing configuration without inventing a project number", async () => {
      const root = await tempDir();
      await expectDiagnostic(resolveLocalCwd(context, config(root, "")), "（未配置）", "member_agent_cwd_unresolved", "没有配置");
    });

    it.each(["configDir", "codexHome", "runtimeDir"] as const)("names a path protected by %s", async (key) => {
      const root = await tempDir();
      const cwd = path.join(config(root, "")[key], "private");
      await expectDiagnostic(resolveLocalCwd(context, config(root, cwd)), cwd, "member_agent_cwd_unresolved", "独立项目目录");
    });

    it("names a path under the user's default Codex home", async () => {
      const root = await tempDir();
      const previous = process.env.USERPROFILE;
      process.env.USERPROFILE = path.join(root, "user");
      try {
        const cwd = path.join(process.env.USERPROFILE, ".codex", "private");
        await expectDiagnostic(resolveLocalCwd(context, config(root, cwd)), cwd, "member_agent_cwd_unresolved", "独立项目目录");
      } finally {
        if (previous === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = previous;
      }
    });

    it("names the actual missing directory", async () => {
      const root = await tempDir();
      const cwd = path.join(root, "not-created");
      await expectDiagnostic(resolveLocalCwd(context, config(root, cwd)), cwd, "member_agent_cwd_missing", "不存在");
    });

    it("names an existing file that cannot serve as the directory", async () => {
      const root = await tempDir();
      const cwd = path.join(root, "not-a-directory");
      await writeFile(cwd, "fixture");
      await expectDiagnostic(resolveLocalCwd(context, config(root, cwd)), cwd, "member_agent_cwd_missing", "不是目录");
    });

    it.each(["EACCES", "EPERM"])("reports %s during stat as permission denied, not a missing directory", async (code) => {
      const root = await tempDir();
      const cwd = path.join(root, "permission-denied");
      const pending = resolveLocalCwd(context, config(root, cwd), { stat: async () => { throw Object.assign(new Error("fixture stat denied"), { code }); } });
      await expectDiagnostic(pending, cwd, "member_agent_cwd_missing", "无权限");
      await expect(pending).rejects.not.toThrow("不存在");
    });

    it.each([["ENOTDIR", "不存在"], ["EIO", "无法访问"]])("localizes %s during stat with the configured path", async (code, reason) => {
      const root = await tempDir();
      const cwd = path.join(root, "project");
      await expectDiagnostic(resolveLocalCwd(context, config(root, cwd), { stat: async () => { throw Object.assign(new Error("fixture stat failure"), { code }); } }), cwd, "member_agent_cwd_missing", reason);
    });

    it.each(["EACCES", "EPERM", "ENOENT", "EIO"])("localizes %s during realpath with the configured path", async (code) => {
      const root = await tempDir();
      const cwd = path.join(root, "project");
      await mkdir(cwd);
      const pending = resolveLocalCwd(context, config(root, cwd), { stat, realpath: async () => { throw Object.assign(new Error("fixture realpath failure"), { code }); } });
      await expectDiagnostic(pending, cwd, "member_agent_cwd_missing", code === "ENOENT" ? "不存在" : code === "EIO" ? "无法访问" : "无权限");
    });

    it("names both the configured alias and its protected real destination", async () => {
      const root = await tempDir();
      const cwd = path.join(root, "alias");
      const target = path.join(root, "codex", "private");
      await mkdir(cwd);
      const pending = resolveLocalCwd(context, config(root, cwd), { stat,
        realpath: async (candidate: string) => candidate === cwd ? target : path.resolve(candidate) });
      await expectDiagnostic(pending, cwd, "member_agent_cwd_unresolved", "独立项目目录");
      await expect(pending).rejects.toThrow(target);
    });
  });

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
