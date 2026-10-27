import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodePublicSshPlaceholder } from "../scripts/runtime-placeholder.mjs";

const memberAgentDir = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(memberAgentDir, "..");
const runtimeDir = path.resolve(memberAgentDir, "runtime");
const buildScript = path.resolve(memberAgentDir, "scripts/build-runtime.mjs");
const bundleRelative = path.join("server", "dist", "codex-local.mjs");
const assets = [
  path.join("server", "dist", "codex-auth-merge-decision.cjs"),
  path.join("server", "dist", "codex-auth-merge-extract.sh"),
];

let repoOutExistedBefore = false;
let buildOutput = "";

function runBuilder(args: string[] = []) {
  return spawnSync(process.execPath, [buildScript, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
  });
}

async function copyRuntimeToTemp() {
  const tempRoot = await fs.mkdtemp(path.join(tmpdir(), "member-agent-runtime-import-"));
  const copiedRuntime = path.resolve(tempRoot, "runtime");
  await fs.cp(runtimeDir, copiedRuntime, { recursive: true, dereference: false });
  return { tempRoot, copiedRuntime };
}

async function importBundle(copiedRuntime: string) {
  const bundlePath = path.resolve(copiedRuntime, bundleRelative);
  return import(`${pathToFileURL(bundlePath).href}?test=${randomUUID()}`);
}

describe("Codex runtime build", () => {
  beforeAll(async () => {
    repoOutExistedBefore = await fs.stat(path.resolve(repoRoot, "out")).then(() => true, () => false);
    const trackedBefore = spawnSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: repoRoot, encoding: "utf8" });
    const outputStatusBefore = spawnSync("git", ["status", "--porcelain", "--untracked-files=all", "--", "member-agent/runtime", "out"], { cwd: repoRoot, encoding: "utf8" });
    const build = runBuilder();
    buildOutput = `${build.stdout ?? ""}${build.stderr ?? ""}`;
    expect(build.status, buildOutput).toBe(0);
    const trackedAfter = spawnSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: repoRoot, encoding: "utf8" });
    const outputStatusAfter = spawnSync("git", ["status", "--porcelain", "--untracked-files=all", "--", "member-agent/runtime", "out"], { cwd: repoRoot, encoding: "utf8" });
    expect(trackedAfter.stdout).toBe(trackedBefore.stdout);
    expect(outputStatusAfter.stdout).toBe(outputStatusBefore.stdout);
  }, 120_000);

  afterAll(async () => {
    const repoOutExistsAfter = await fs.stat(path.resolve(repoRoot, "out")).then(() => true, () => false);
    expect(repoOutExistsAfter).toBe(repoOutExistedBefore);
  });

  it("writes the required layout and complete manifest under runtime/", async () => {
    const expectedPaths = [
      bundleRelative,
      ...assets,
      path.join("skills", "paperclip", "SKILL.md"),
      "MANIFEST.json",
    ];
    for (const relative of expectedPaths) {
      await expect(fs.access(path.resolve(runtimeDir, relative))).resolves.toBeUndefined();
    }

    const manifest = JSON.parse(await fs.readFile(path.resolve(runtimeDir, "MANIFEST.json"), "utf8"));
    expect(manifest).toEqual(expect.objectContaining({
      builtAt: expect.any(String),
      repoCommit: expect.any(String),
      adapterPackageVersion: expect.any(String),
      bundleSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      assets: expect.objectContaining({
        [assets[0].replaceAll("\\", "/")]: expect.stringMatching(/^[a-f0-9]{64}$/),
        [assets[1].replaceAll("\\", "/")]: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      skills: expect.objectContaining({ paperclip: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      esbuildVersion: expect.any(String),
      nodeTarget: "node24",
    }));
    expect(Number.isNaN(Date.parse(manifest.builtAt))).toBe(false);
    const packageSizesLine = buildOutput.split(/\r?\n/).find((line) => line.includes("包体积"));
    expect(packageSizesLine).toBeDefined();
    const packageSizes = JSON.parse(packageSizesLine!.slice(packageSizesLine!.indexOf("：") + 1));
    expect(Object.keys(packageSizes).length).toBeGreaterThan(0);
  });

  it("keeps the public SSH placeholder value while emitting no PEM marker into the scanned bundle", async () => {
    const placeholder = "-----BEGIN RSA PRIVATE KEY-----";
    const output = encodePublicSshPlaceholder(`export default {placeholder:${JSON.stringify(placeholder)}};`);
    expect(output).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
    const module = await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
    expect(module.default.placeholder).toBe(placeholder);
  });

  it("imports execute from a temporary copy without node_modules ancestors", async () => {
    const { tempRoot, copiedRuntime } = await copyRuntimeToTemp();
    try {
      let ancestor = tempRoot;
      while (true) {
        await expect(fs.stat(path.resolve(ancestor, "node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
        const parent = path.dirname(ancestor);
        if (parent === ancestor) break;
        ancestor = parent;
      }
      const module = await importBundle(copiedRuntime);
      expect(typeof module.execute).toBe("function");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it.each(assets)("fails to import when required sidecar %s is missing", async (relativeAsset) => {
    const { tempRoot, copiedRuntime } = await copyRuntimeToTemp();
    try {
      await fs.rm(path.resolve(copiedRuntime, relativeAsset));
      await expect(importBundle(copiedRuntime)).rejects.toThrow();
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it.each([
    ["relative path outside runtime", "member-agent-build-relative-test"],
    ["parent traversal", path.join("..", "member-agent-build-parent-test")],
    ["repository root", repoRoot],
  ])("rejects malicious --out: %s before writing", (_label, outputPath) => {
    const result = runBuilder(["--out", outputPath]);
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    expect(result.status).toBe(1);
    expect(output).toMatch(/必须位于 member-agent\/runtime/);
    expect(output).not.toContain("构建完成");
  });
});
