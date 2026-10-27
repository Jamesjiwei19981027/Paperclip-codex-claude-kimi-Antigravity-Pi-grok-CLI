import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { processMayBeAlive, windowsProcessListed } from "../services/conversation-continuation.js";

const throwing = (code: string) => () => {
  throw Object.assign(new Error(code), { code });
};

describe("processMayBeAlive", () => {
  it("treats a signalable PID as alive", () => {
    expect(processMayBeAlive(10, { kill: () => {} })).toBe(true);
  });

  it("treats ESRCH as gone", () => {
    expect(processMayBeAlive(10, { kill: throwing("ESRCH") })).toBe(false);
  });

  it("treats a Windows EPERM PID that tasklist does not list as gone", () => {
    expect(processMayBeAlive(30452, { platform: "win32", kill: throwing("EPERM"), processListed: () => false })).toBe(false);
  });

  it("keeps a listed Windows EPERM PID alive", () => {
    expect(processMayBeAlive(30452, { platform: "win32", kill: throwing("EPERM"), processListed: () => true })).toBe(true);
  });

  it("stays conservative when tasklist cannot run", () => {
    expect(processMayBeAlive(30452, { platform: "win32", kill: throwing("EPERM"), processListed: () => null })).toBe(true);
  });

  it("keeps EPERM alive off Windows", () => {
    expect(processMayBeAlive(30452, { platform: "linux", kill: throwing("EPERM"), processListed: () => false })).toBe(true);
  });

  it.runIf(process.platform === "win32")("lists a running PID and not an exited one", () => {
    expect(windowsProcessListed(process.pid)).toBe(true);
    const exited = spawnSync(process.execPath, ["-e", "0"]).pid!;
    expect(windowsProcessListed(exited)).toBe(false);
  });
});
