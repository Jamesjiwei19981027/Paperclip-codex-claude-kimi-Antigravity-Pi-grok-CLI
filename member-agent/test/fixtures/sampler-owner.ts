// Test-only owner: the test kills this Node process without graceful tracker cleanup.
import { WindowsProcessSampler } from "../../src/process-sampler.ts";
const sampler = new WindowsProcessSampler({ intervalMs: 100, onRows: () => process.send?.({ pid: sampler.pid }), warn: () => {} });
sampler.start();
