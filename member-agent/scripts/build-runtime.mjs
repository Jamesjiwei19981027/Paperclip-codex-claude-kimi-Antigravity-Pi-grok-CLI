import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { encodePublicSshPlaceholder } from "./runtime-placeholder.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const memberAgentDir = path.resolve(path.dirname(scriptPath), "..");
const repoRoot = path.resolve(memberAgentDir, "..");
const runtimeRoot = path.resolve(memberAgentDir, "runtime");
const adapterDir = path.resolve(repoRoot, "packages/adapters/codex-local");
const adapterEntry = path.resolve(adapterDir, "src/server/execute.ts");
const adapterPackagePath = path.resolve(adapterDir, "package.json");
const skillsSource = path.resolve(repoRoot, "skills/paperclip");
const nodeTarget = "node24";
const nodeRequire = createRequire(import.meta.url);

function assertAbsolute(target, label) {
  if (!path.isAbsolute(target) || path.resolve(target) !== target) {
    throw new Error(`${label} 必须是规范化的绝对路径：${target}`);
  }
  return target;
}

function assertInsideRuntime(target, label) {
  const absolute = assertAbsolute(path.resolve(target), label);
  const relative = path.relative(runtimeRoot, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} 必须位于 member-agent/runtime/ 内：${absolute}`);
  }
  return absolute;
}

function parseOutputDir(args) {
  let rawOutput;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--out") {
      throw new Error(`未知参数：${args[index]}`);
    }
    if (rawOutput !== undefined || !args[index + 1] || args[index + 1].startsWith("--")) {
      throw new Error("--out 后必须提供一个目录路径，且只能指定一次");
    }
    rawOutput = args[index + 1];
    index += 1;
  }
  const outputDir = rawOutput === undefined
    ? runtimeRoot
    : path.resolve(process.cwd(), rawOutput);
  return assertInsideRuntime(outputDir, "运行时输出目录");
}

function findEsbuild() {
  const pnpmStore = path.resolve(repoRoot, "node_modules/.pnpm");
  const entries = [];
  try {
    for (const entry of fsSync.readdirSync(pnpmStore, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^esbuild@/.test(entry.name)) continue;
      const packageDir = path.resolve(pnpmStore, entry.name, "node_modules/esbuild");
      const packageJson = path.resolve(packageDir, "package.json");
      try {
        const metadata = JSON.parse(fsSync.readFileSync(packageJson, "utf8"));
        entries.push({ packageDir, version: metadata.version });
      } catch {
        // Some pnpm entries can be platform stubs without a usable package.
      }
    }
  } catch {
    // The error below explains the required setup in user-facing language.
  }

  entries.sort((left, right) => compareVersions(right.version, left.version));
  for (const entry of entries) {
    try {
      const requireFromPackage = createRequire(path.resolve(entry.packageDir, "package.json"));
      const esbuild = requireFromPackage("esbuild");
      return { esbuild, version: entry.version };
    } catch {
      // Try the next installed pnpm version, if any.
    }
  }
  throw new Error("找不到可用的 esbuild。请先在 Paperclip 仓库安装依赖，再运行 build-runtime。");
}

function compareVersions(left, right) {
  const leftParts = String(left).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = String(right).split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function hashDirectory(directory) {
  const hash = createHash("sha256");
  async function visit(current, relative = "") {
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = path.resolve(current, entry.name);
      if (entry.isSymbolicLink()) {
        const link = await fs.readlink(absolute);
        hash.update(`L\0${rel}\0${link}\0`);
      } else if (entry.isDirectory()) {
        hash.update(`D\0${rel}\0`);
        await visit(absolute, rel);
      } else if (entry.isFile()) {
        hash.update(`F\0${rel}\0`);
        hash.update(await fs.readFile(absolute));
      }
    }
  }
  await visit(directory);
  return hash.digest("hex");
}

async function copyAsset(source, destination) {
  const absoluteSource = assertAbsolute(path.resolve(source), "附属文件源路径");
  const absoluteDestination = assertInsideRuntime(path.resolve(destination), "附属文件目标路径");
  await fs.mkdir(path.dirname(absoluteDestination), { recursive: true });
  await fs.copyFile(absoluteSource, absoluteDestination);
  return sha256(await fs.readFile(absoluteDestination));
}

async function assertRealRuntimeTarget(target, label) {
  const absolute = assertInsideRuntime(path.resolve(target), label);
  const realRuntime = await fs.realpath(runtimeRoot);
  let nearestExisting = absolute;
  while (true) {
    try {
      await fs.lstat(nearestExisting);
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(nearestExisting);
      if (parent === nearestExisting) throw error;
      nearestExisting = parent;
    }
  }
  const realParent = await fs.realpath(nearestExisting);
  const relative = path.relative(realRuntime, realParent);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} 解析后的实际路径逃出了 member-agent/runtime/：${realParent}`);
  }
  return absolute;
}

function getRepoCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: assertAbsolute(path.resolve(repoRoot), "Git 工作目录"),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

function packageNameFromInput(inputPath) {
  const marker = `${path.sep}node_modules${path.sep}.pnpm${path.sep}`;
  const normalized = inputPath.replaceAll("/", path.sep);
  const index = normalized.lastIndexOf(marker);
  if (index < 0) return "(workspace)";
  const remainder = normalized.slice(index + marker.length);
  const packageSegment = remainder.split(path.sep, 1)[0];
  return packageSegment.replace(/@[0-9].*$/, "");
}

function reportPackageSizes(metafile, outputFile) {
  const output = Object.entries(metafile.outputs).find(([candidate]) => {
    const absoluteCandidate = path.resolve(repoRoot, candidate);
    return absoluteCandidate.toLowerCase() === outputFile.toLowerCase();
  })?.[1] ?? Object.values(metafile.outputs)[0];
  const packageSizes = new Map();
  for (const [input, contribution] of Object.entries(output?.inputs ?? {})) {
    const name = packageNameFromInput(input);
    packageSizes.set(name, (packageSizes.get(name) ?? 0) + contribution.bytesInOutput);
  }
  const sorted = Object.fromEntries([...packageSizes.entries()].sort((left, right) => right[1] - left[1]));
  console.log(`[runtime-build] 包体积（bytes）：${JSON.stringify(sorted)}`);
}

async function build() {
  const outputDir = parseOutputDir(process.argv.slice(2));
  const outputFile = assertInsideRuntime(path.resolve(outputDir, "server/dist/codex-local.mjs"), "esbuild outfile");
  const distDir = assertInsideRuntime(path.resolve(outputDir, "server/dist"), "运行时 dist 目录");
  const skillsDestination = assertInsideRuntime(path.resolve(outputDir, "skills/paperclip"), "技能复制目标");
  const manifestPath = assertInsideRuntime(path.resolve(outputDir, "MANIFEST.json"), "MANIFEST 目标路径");
  const absWorkingDir = assertAbsolute(path.resolve(repoRoot), "esbuild absWorkingDir");

  const requiredInputs = [
    adapterEntry,
    path.resolve(adapterDir, "src/server/codex-auth-merge-decision.cjs"),
    path.resolve(adapterDir, "src/server/codex-auth-merge-extract.sh"),
    skillsSource,
    adapterPackagePath,
  ];
  for (const input of requiredInputs) {
    await fs.access(assertAbsolute(path.resolve(input), "构建输入路径"));
  }

  const { esbuild, version: esbuildVersion } = findEsbuild();
  await fs.mkdir(runtimeRoot, { recursive: true });
  const realMemberAgent = await fs.realpath(memberAgentDir);
  const realRuntime = await fs.realpath(runtimeRoot);
  if (path.resolve(realRuntime).toLowerCase() !== path.resolve(realMemberAgent, "runtime").toLowerCase()) {
    throw new Error(`运行时目录不得是指向其他位置的符号链接或目录联接：${realRuntime}`);
  }
  await assertRealRuntimeTarget(outputDir, "运行时输出目录");
  await assertRealRuntimeTarget(outputFile, "esbuild outfile");
  await assertRealRuntimeTarget(skillsDestination, "技能复制目标");
  await assertRealRuntimeTarget(manifestPath, "MANIFEST 目标路径");
  await fs.mkdir(distDir, { recursive: true });
  await fs.mkdir(path.dirname(skillsDestination), { recursive: true });
  const result = await esbuild.build({
    absWorkingDir,
    entryPoints: [adapterEntry],
    outfile: outputFile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: nodeTarget,
    banner: {
      js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
    },
    metafile: true,
    logLevel: "silent",
  });

  const claudeFile = assertInsideRuntime(path.resolve(outputDir, "server/dist/claude-local.mjs"), "Claude bundle");
  await assertRealRuntimeTarget(claudeFile, "Claude bundle");
  const claudeResult = await esbuild.build({
    absWorkingDir, entryPoints: [path.resolve(repoRoot, "packages/adapters/claude-local/src/server/execute.ts")],
    outfile: claudeFile, bundle: true, platform: "node", format: "esm", target: nodeTarget,
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
    logLevel: "silent",
  });
  if (claudeResult.warnings.length) throw new Error(`Claude 构建产生 ${claudeResult.warnings.length} 条警告。`);
  await fs.writeFile(claudeFile, encodePublicSshPlaceholder(await fs.readFile(claudeFile, "utf8")), "utf8");

  const bundle = await fs.readFile(outputFile, "utf8");
  await fs.writeFile(outputFile, encodePublicSshPlaceholder(bundle), "utf8");

  if (result.warnings.length > 0) {
    const formatted = await esbuild.formatMessages(result.warnings, { kind: "warning", color: true });
    for (const warning of formatted) console.error(warning);
    throw new Error(`构建产生 ${result.warnings.length} 条警告；请先处理警告再继续。`);
  }
  reportPackageSizes(result.metafile, outputFile);

  const assets = { "server/dist/claude-local.mjs": sha256(await fs.readFile(claudeFile)) };
  const assetSpecs = [
    ["codex-auth-merge-decision.cjs", "server/dist/codex-auth-merge-decision.cjs"],
    ["codex-auth-merge-extract.sh", "server/dist/codex-auth-merge-extract.sh"],
  ];
  for (const [fileName, relativeTarget] of assetSpecs) {
    const source = path.resolve(adapterDir, "src/server", fileName);
    const destination = assertInsideRuntime(path.resolve(outputDir, relativeTarget), `附属文件目标 ${fileName}`);
    await assertRealRuntimeTarget(destination, `附属文件目标 ${fileName}`);
    assets[relativeTarget.replaceAll("\\", "/")] = await copyAsset(source, destination);
  }

  await fs.rm(skillsDestination, { recursive: true, force: true });
  await fs.cp(assertAbsolute(path.resolve(skillsSource), "技能源路径"), skillsDestination, {
    recursive: true,
    force: true,
    dereference: false,
  });

  const adapterPackage = JSON.parse(await fs.readFile(adapterPackagePath, "utf8"));
  const manifest = {
    builtAt: new Date().toISOString(),
    repoCommit: getRepoCommit(),
    adapterPackageVersion: adapterPackage.version,
    bundleSha256: sha256(await fs.readFile(outputFile)),
    assets,
    skills: { "paperclip": await hashDirectory(skillsDestination) },
    esbuildVersion,
    nodeTarget,
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`[runtime-build] 构建完成：${outputDir}`);
  console.log(`[runtime-build] 清单：${manifestPath}`);
  console.log(`[runtime-build] 适配器版本：${manifest.adapterPackageVersion}；esbuild ${esbuildVersion}；目标 ${nodeTarget}`);
}

try {
  await build();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
