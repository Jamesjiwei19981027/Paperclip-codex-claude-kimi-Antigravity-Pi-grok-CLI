import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { expect, it } from "vitest";

it("ships a loadable Claude CLI bundle covered by the same runtime manifest", async () => {
  const root = path.resolve(import.meta.dirname, "../runtime");
  const manifest = JSON.parse(await readFile(path.join(root, "MANIFEST.json"), "utf8"));
  const bytes = await readFile(path.join(root, "server/dist/claude-local.mjs"));
  expect(manifest.assets["server/dist/claude-local.mjs"]).toBe(createHash("sha256").update(bytes).digest("hex"));
  const runtime = await import(new URL("../runtime/server/dist/claude-local.mjs", import.meta.url).href);
  expect(typeof runtime.execute).toBe("function");
});
