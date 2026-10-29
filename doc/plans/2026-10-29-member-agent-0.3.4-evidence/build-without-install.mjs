import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import * as builder from "../../../member-agent/scripts/build-installer.mjs";

const repo = process.cwd();
const approved = JSON.parse(await fs.readFile(new URL("approved-inputs.json", import.meta.url), "utf8"));
const outputDir = path.resolve(repo, "member-agent/dist-installer");
const repoCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim();
for (const executor of ["codebuddy", "codex"]) {
  const input = approved[executor], release = path.resolve(repo, input.directory);
  const manifestBytes = await fs.readFile(path.join(release, "MANIFEST.json"));
  if (createHash("sha256").update(manifestBytes).digest("hex") !== input.manifestSha256) throw new Error("Approved manifest changed");
  const nodeDirectory = path.join(release, "app/node");
  await builder.verifyPinnedBinary(path.join(nodeDirectory, "node.exe"), "app/node/node.exe");
  let codebuddy, codexDirectory;
  if (executor === "codebuddy") codebuddy = await builder.reuseVerifiedCodeBuddy(path.join(release, "app/codebuddy"), path.join(release, "MANIFEST.json"), input.manifestSha256);
  else {
    codexDirectory = path.join(release, "app/codex");
    for (const name of ["codex.exe", "codex-code-mode-host.exe"]) await builder.verifyPinnedBinary(path.join(codexDirectory, name), `app/codex/${name}`);
  }
  console.log(`[installer-build] ${executor}: approved vendor files verified; no dependency installation`);
  const result = await builder.assembleInstaller({ outputDir, nodeDirectory, codexDirectory, codebuddy, executor, repoCommit });
  const zip = path.join(outputDir, path.basename(result.packageDir) + ".zip");
  await builder.archiveInstaller(result.packageDir, zip);
  const bytes = await fs.readFile(zip);
  console.log(JSON.stringify({ path: path.relative(repo, zip).replaceAll("\\", "/"), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }));
}
