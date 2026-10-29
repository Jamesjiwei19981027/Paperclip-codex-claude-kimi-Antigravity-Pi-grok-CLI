import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { buildCodeBuddyLoginEnvironment, hasCodeBuddyLogin, verifyCodeBuddyPackage } from "../src/codebuddy-cli.ts";
import { assertIsolatedConfigHome } from "../src/executors/shared-support.ts";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it("checks shared credential existence without reading it", async () => {
  const seen: string[] = [];
  expect(await hasCodeBuddyLogin("C:/member", async file => { seen.push(String(file)); })).toBe(true);
  expect(seen).toEqual([path.join("C:/member", "AppData/Local/CodeBuddyExtension/Data/Public/auth/Tencent-Cloud.coding-copilot.info")]);
});
it("login isolates configuration without overriding home or inheriting secrets", () => {
  const env = buildCodeBuddyLoginEnvironment({ PATH: "tools", USERPROFILE: "real-member", HOME: "real-home", ANTHROPIC_API_KEY: "no", PAPERCLIP_AGENT_KEY: "no" }, "isolated");
  expect(env).toMatchObject({ USERPROFILE: "real-member", HOME: "real-home", CODEBUDDY_CONFIG_DIR: "isolated" });
  expect(env).not.toHaveProperty("CODEX_HOME"); expect(env).not.toHaveProperty("ANTHROPIC_API_KEY"); expect(env).not.toHaveProperty("PAPERCLIP_AGENT_KEY");
});
it("detects changed and unlisted CodeBuddy package files in an installed manifest", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cb-package-check-")); roots.push(root);
  const file = path.join(root, "codebuddy/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy");
  await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, "trusted");
  const bytes = await readFile(file);
  await writeFile(path.join(root, "PACKAGE-MANIFEST.json"), JSON.stringify({ executor: "codebuddy", codebuddyVersion: "2.169.0", files: [{ path: "app/codebuddy/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }] }));
  expect(await verifyCodeBuddyPackage(file)).toEqual([]);
  await writeFile(path.join(path.dirname(file), "unexpected"), "extra");
  expect((await verifyCodeBuddyPackage(file)).join(" ")).toMatch(/未列入/);
  await rm(path.join(path.dirname(file), "unexpected")); await writeFile(file, "modified");
  expect((await verifyCodeBuddyPackage(file)).join(" ")).toMatch(/哈希|大小/);
});
it("rejects a personal config subtree and a junction alias before writing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cb-home-boundary-")); roots.push(root);
  const personal = path.join(root, ".codebuddy"); await mkdir(personal);
  const alias = path.join(root, "pretend-isolated"); await symlink(personal, alias, "junction");
  await expect(assertIsolatedConfigHome(path.join(personal, "member"), personal)).rejects.toThrow(/codebuddyHome/);
  await expect(assertIsolatedConfigHome(path.join(alias, "nested"), personal)).rejects.toThrow(/codebuddyHome/);
  await expect(assertIsolatedConfigHome(path.join(root, "isolated/new"), personal)).resolves.toBe(path.join(root, "isolated/new"));
});

it("checks installed file sizes but hashes only the CLI and package entry files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cb-fast-check-")); roots.push(root);
  const entry = "codebuddy/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy";
  const files = [entry, "codebuddy/package.json", "codebuddy/package-lock.json", "codebuddy/lib/helper.js"];
  const rows = [];
  for (const rel of files) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true }); await writeFile(path.join(root, rel), "trusted");
    rows.push({ path: `app/${rel}`, size: 7, sha256: createHash("sha256").update("trusted").digest("hex") });
  }
  const manifest = JSON.stringify({ files: rows });
  await writeFile(path.join(root, "PACKAGE-MANIFEST.json"), manifest);
  await writeFile(path.join(root, files[3]), "changed");
  expect(await verifyCodeBuddyPackage(path.join(root, entry))).toEqual([]);
  for (const rel of files.slice(0, 3)) {
    await writeFile(path.join(root, rel), "changed");
    expect((await verifyCodeBuddyPackage(path.join(root, entry))).join(" ")).toContain(rel);
    await writeFile(path.join(root, rel), "trusted");
  }
  await writeFile(path.join(root, files[3]), "short");
  expect((await verifyCodeBuddyPackage(path.join(root, entry))).join(" ")).toContain(files[3]);
  await rm(path.join(root, files[3]));
  expect(await verifyCodeBuddyPackage(path.join(root, entry))).not.toEqual([]);
});

it("retains full content hashing for extracted packages", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cb-full-check-")); roots.push(root);
  const rel = "codebuddy/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy";
  await mkdir(path.dirname(path.join(root, "app", rel)), { recursive: true }); await writeFile(path.join(root, "app", rel), "changed");
  await writeFile(path.join(root, "MANIFEST.json"), JSON.stringify({ files: [{ path: `app/${rel}`, size: 7, sha256: createHash("sha256").update("trusted").digest("hex") }] }));
  expect((await verifyCodeBuddyPackage(path.join(root, "app", rel))).join(" ")).toMatch(/哈希/);
});
