import { afterEach, describe, expect, it } from "vitest";
import { startFakeModelServer } from "./fixtures/fake-model-server.mjs";

const servers: Awaited<ReturnType<typeof startFakeModelServer>>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.close())); });

describe("loopback fake model acceptance server", () => {
  it("binds only loopback and delays the response for cancellation and timeout checks", async () => {
    const fake = await startFakeModelServer({ delayMs: 250 });
    servers.push(fake);
    const address = fake.server.address();
    expect(address && typeof address !== "string" ? address.address : "").toBe("127.0.0.1");

    const controller = new AbortController();
    const startedAt = Date.now();
    const response = fetch(`${fake.url}/responses`, { method: "POST", body: "{}", signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    await expect(response).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - startedAt).toBeLessThan(200);
    await new Promise((resolve) => setTimeout(resolve, 270));
  });

  it("rejects invalid delays", async () => {
    await expect(startFakeModelServer({ delayMs: -1 })).rejects.toThrow("delayMs");
    await expect(startFakeModelServer({ delayMs: 1.5 })).rejects.toThrow("delayMs");
  });
});
