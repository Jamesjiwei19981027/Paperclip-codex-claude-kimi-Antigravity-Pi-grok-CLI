import { afterEach, describe, expect, it, vi } from "vitest";

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: execFileMock };
});

import { terminateProcessTree } from "../src/process-tree.ts";

afterEach(() => vi.restoreAllMocks());

describe("terminateProcessTree", () => {
  it.skipIf(process.platform !== "win32")("treats a target that exits during taskkill as already terminated", async () => {
    let checks = 0;
    vi.spyOn(process, "kill").mockImplementation(() => {
      checks++;
      if (checks === 1) return true;
      throw Object.assign(new Error("process exited"), { code: "ESRCH" });
    });
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(Object.assign(new Error("taskkill found no process"), { code: 128 }));
    });

    await expect(terminateProcessTree(42_424_242)).resolves.toBeUndefined();
    expect(checks).toBe(2);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it.skipIf(process.platform !== "win32")("still fails when taskkill fails and the process remains", async () => {
    vi.spyOn(process, "kill").mockReturnValue(true);
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(Object.assign(new Error("access denied"), { code: 5 }));
    });

    await expect(terminateProcessTree(42_424_243)).rejects.toThrow("taskkill 失败");
    expect(process.kill).toHaveBeenCalledTimes(2);
  });
});
