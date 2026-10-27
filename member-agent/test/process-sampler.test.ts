import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WindowsProcessSampler } from "../src/process-sampler.ts";

const samplers: WindowsProcessSampler[] = [];
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
afterEach(async () => { for (const sampler of samplers.splice(0)) await sampler.stop(); });

describe("persistent Windows process sampler", () => {
  it.skipIf(process.platform !== "win32")("uses one PowerShell process, samples once more at stop and confirms its exit", async () => {
    let samples = 0;
    let includedSelf = false;
    const sampler = new WindowsProcessSampler({ intervalMs: 3000, onRows: rows => { samples++; includedSelf ||= rows.some(row => row.pid === sampler.pid); }, warn: () => {} });
    samplers.push(sampler);
    sampler.start();
    await vi.waitFor(() => expect(samples).toBeGreaterThan(0), { timeout: 5000 });
    const initialPid = sampler.pid;
    await vi.waitFor(() => expect(samples).toBeGreaterThan(1), { timeout: 5000 });
    const pid = sampler.pid!;
    expect(pid).toBe(initialPid);
    expect(alive(pid)).toBe(true);
    const before = samples;
    await sampler.stop();
    expect(samples).toBeGreaterThan(before);
    expect(alive(pid)).toBe(false);
    expect(sampler.pid).toBeNull();
    expect(includedSelf).toBe(false);
  });

  it.skipIf(process.platform !== "win32")("restarts after its PowerShell is killed externally and continues sampling", async () => {
    let samples = 0;
    const warnings: string[] = [];
    const sampler = new WindowsProcessSampler({ intervalMs: 100, restartDelayMs: 10, onRows: () => { samples++; }, warn: message => warnings.push(message) });
    samplers.push(sampler);
    sampler.start();
    await vi.waitFor(() => expect(samples).toBeGreaterThan(0), { timeout: 5000 });
    const previousPid = sampler.pid!;
    const before = samples;
    process.kill(previousPid);
    await vi.waitFor(() => { expect(sampler.pid).not.toBe(previousPid); expect(samples).toBeGreaterThan(before); }, { timeout: 5000 });
    expect(warnings).toHaveLength(1);
    const lastPid = sampler.pid!;
    await sampler.stop();
    expect(alive(previousPid)).toBe(false);
    expect(alive(lastPid)).toBe(false);
  });

  it("warns once and stops after three restarts when output cannot be parsed", async () => {
    let launches = 0;
    const warnings: string[] = [];
    const children: ChildProcessWithoutNullStreams[] = [];
    const sampler = new WindowsProcessSampler({ intervalMs: 20, restartDelayMs: 1, onRows: () => { throw new Error("invalid rows must not be delivered"); }, warn: message => warnings.push(message),
      launch: () => {
        launches++;
        const child = Object.assign(new EventEmitter(), { pid: 800000 + launches, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => { queueMicrotask(() => child.emit("close", 1, null)); return true; }) }) as unknown as ChildProcessWithoutNullStreams;
        children.push(child);
        queueMicrotask(() => child.stdout.emit("data", "NOT JSON\n"));
        return child;
      },
    });
    samplers.push(sampler);
    sampler.start();
    await vi.waitFor(() => { expect(launches).toBe(4); expect(sampler.pid).toBeNull(); });
    await sampler.stop();
    expect(warnings).toHaveLength(1);
    expect(children.every(child => vi.mocked(child.kill).mock.calls.length === 1)).toBe(true);
  });

  it.skipIf(process.platform !== "win32")("exits when its owning Node process is killed without calling stop", async () => {
    const owner = fork(fileURLToPath(new URL("./fixtures/sampler-owner.ts", import.meta.url)), [], { stdio: ["ignore", "ignore", "ignore", "ipc"], execArgv: [] });
    let samplerPid: number | undefined;
    try {
      samplerPid = await new Promise<number>((resolve, reject) => { owner.once("message", message => resolve((message as { pid: number }).pid)); owner.once("error", reject); });
      expect(alive(samplerPid)).toBe(true);
      owner.kill();
      await vi.waitFor(() => expect(alive(samplerPid!)).toBe(false), { timeout: 5000 });
    } finally { owner.kill(); if (samplerPid && alive(samplerPid)) process.kill(samplerPid); }
  });
});
