import { describe, expect, it } from "vitest";
import { legacyStoppedBeforeLaunch, recordedProcessAbsent } from "./agent-execution-stop.js";

// Shape of a real run (AI-66, 2026-10-21) cancelled 0.07s after start by a reassignment:
// Stop fenced it during startup, no adapter ever launched, and agent pause stayed "pausing".
const fencedBeforeLaunch = {
  runtimeMode: "legacy",
  status: "cancelled",
  executionStage: "settled",
  resultJson: { reassignmentStopConfirmed: true, startupCancellation: { requestedAt: "2026-10-21T01:35:53.588Z", beforeNativeSelection: false } },
  processPid: null,
  processGroupId: null,
  processStartedAt: null,
  sessionIdAfter: null,
  controllerLeaseExpiresAt: null,
} as Parameters<typeof legacyStoppedBeforeLaunch>[0];

describe("legacyStoppedBeforeLaunch", () => {
  it("treats a startup-fenced legacy run with no launch evidence as stopped", () => {
    expect(legacyStoppedBeforeLaunch(fencedBeforeLaunch, false)).toBe(true);
  });

  it("keeps waiting when any provider execution evidence exists", () => {
    expect(legacyStoppedBeforeLaunch(fencedBeforeLaunch, true)).toBe(false);
  });

  it("keeps waiting without a startup fence", () => {
    expect(legacyStoppedBeforeLaunch({ ...fencedBeforeLaunch, resultJson: { reassignmentStopConfirmed: true } }, false)).toBe(false);
  });

  it("keeps waiting when a process, session, or live controller lease was recorded", () => {
    const now = new Date("2026-10-22T00:00:00Z");
    expect(legacyStoppedBeforeLaunch({ ...fencedBeforeLaunch, processPid: 123 }, false, now)).toBe(false);
    expect(legacyStoppedBeforeLaunch({ ...fencedBeforeLaunch, processStartedAt: now }, false, now)).toBe(false);
    expect(legacyStoppedBeforeLaunch({ ...fencedBeforeLaunch, sessionIdAfter: "s1" }, false, now)).toBe(false);
    expect(legacyStoppedBeforeLaunch({ ...fencedBeforeLaunch, controllerLeaseExpiresAt: new Date("2026-10-22T00:01:00Z") }, false, now)).toBe(false);
  });

  it("does not apply to native runs or unsettled runs", () => {
    expect(legacyStoppedBeforeLaunch({ ...fencedBeforeLaunch, runtimeMode: "native" }, false)).toBe(false);
    expect(legacyStoppedBeforeLaunch({ ...fencedBeforeLaunch, executionStage: "dispatching" }, false)).toBe(false);
  });
});

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
