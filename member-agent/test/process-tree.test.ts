import { afterEach, describe, expect, it, vi } from "vitest";

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: execFileMock };
});

import { ProcessTreeTracker, terminateProcessTree, terminateRecordedProcess } from "../src/process-tree.ts";

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

describe("descendant snapshots", () => {
  it("retains orphan identities and discovers their later descendants without adopting reused PIDs", async () => {
    let rows = [
      { pid: 41001, parentPid: 1, creationTime: "100" },
      { pid: 41002, parentPid: 41001, creationTime: "101" },
      { pid: 41003, parentPid: 41002, creationTime: "102" },
    ];
    const tracker = new ProcessTreeTracker({ intervalMs: 10, query: async () => rows, warn: () => {} });
    tracker.track(41001);
    await vi.waitFor(() => expect(tracker.identities()).toHaveLength(3));
    rows = [
      { pid: 41001, parentPid: 1, creationTime: "200" },
      { pid: 41999, parentPid: 41001, creationTime: "201" },
      { pid: 41003, parentPid: 41002, creationTime: "102" },
      { pid: 41004, parentPid: 41003, creationTime: "103" },
    ];
    try {
      await vi.waitFor(() => expect(tracker.identities()).toContainEqual({ pid: 41004, creationTime: "103" }));
      expect(tracker.identities()).not.toContainEqual({ pid: 41001, creationTime: "200" });
      expect(tracker.identities().some(record => record.pid === 41999)).toBe(false);
    } finally { await tracker.stop(); }
  });

  it("logs snapshot failures and waits for an in-flight query at cleanup without overlapping it", async () => {
    let release!: () => void;
    let calls = 0;
    const warnings: string[] = [];
    const tracker = new ProcessTreeTracker({ intervalMs: 10, warn: message => warnings.push(message), query: async () => {
      calls++;
      if (calls === 1) throw new Error("fixture query failure");
      await new Promise<void>(resolve => { release = resolve; });
      return [{ pid: 42001, parentPid: 1, creationTime: "300" }];
    } });
    tracker.track(42001);
    await vi.waitFor(() => expect(typeof release).toBe("function"));
    let stopped = false;
    const closing = tracker.stop().then(records => { stopped = true; return records; });
    expect(stopped).toBe(false);
    expect(calls).toBe(2);
    release();
    expect(await closing).toEqual([{ pid: 42001, creationTime: "300" }]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("快照查询失败");
  });

  it("rejects invalid recorded identities before invoking Windows commands", async () => {
    await expect(terminateRecordedProcess({ pid: 123, creationTime: "not-a-time" })).rejects.toThrow("进程身份无效");
  });
});
