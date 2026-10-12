import { describe, expect, it } from "vitest";
import { recordedProcessAbsent } from "./agent-execution-stop.js";

function killFailing(code: string) {
  return () => { throw Object.assign(new Error(code), { code }); };
}

describe("recordedProcessAbsent", () => {
  it("treats a signalable PID as alive", () => {
    expect(recordedProcessAbsent(42, "win32", () => true)).toBe(false);
    expect(recordedProcessAbsent(42, "linux", () => true)).toBe(false);
  });

  it("treats ESRCH as gone on every platform", () => {
    expect(recordedProcessAbsent(42, "win32", killFailing("ESRCH"))).toBe(true);
    expect(recordedProcessAbsent(42, "linux", killFailing("ESRCH"))).toBe(true);
  });

  it("treats EPERM as a reused PID only on Windows", () => {
    expect(recordedProcessAbsent(42, "win32", killFailing("EPERM"))).toBe(true);
    expect(recordedProcessAbsent(42, "linux", killFailing("EPERM"))).toBe(false);
    expect(recordedProcessAbsent(42, "darwin", killFailing("EPERM"))).toBe(false);
  });

  it("checks the current process as alive", () => {
    expect(recordedProcessAbsent(process.pid)).toBe(false);
  });
});
