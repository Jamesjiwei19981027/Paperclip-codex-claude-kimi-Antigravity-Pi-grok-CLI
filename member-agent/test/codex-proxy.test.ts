import { describe, expect, it, vi } from "vitest";
import { resolveCodexProxy, queryWindowsProxy } from "../src/executors/codex-proxy.ts";

const serverUrl = "http://192.168.0.213:3100";
const registry = (values: Record<string, string | number>) => "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\r\n" +
  Object.entries(values).map(([name, value]) => `    ${name}    ${typeof value === "number" ? "REG_DWORD" : "REG_SZ"}    ${typeof value === "number" ? `0x${value}` : value}`).join("\r\n");
const resolve = (values: Record<string, string | number>, env: NodeJS.ProcessEnv = {}) =>
  resolveCodexProxy({ env, serverUrl, platform: "win32", queryRegistry: async () => registry(values) });

describe("Codex per-task proxy environment", () => {
  it("converts a simple Windows endpoint to both HTTP proxy variables", async () => {
    const result = await resolve({ ProxyEnable: 1, ProxyServer: "127.0.0.1:7897" });
    expect(result.env).toEqual({ HTTPS_PROXY: "http://127.0.0.1:7897", HTTP_PROXY: "http://127.0.0.1:7897", NO_PROXY: "localhost,127.0.0.1,::1,192.168.0.213" });
    expect(result.message).toBe("使用系统代理 http://127.0.0.1:7897");
  });
  it.each([
    ["http=127.0.0.1:1;https=127.0.0.1:2;socks=127.0.0.1:3", "http://127.0.0.1:2"],
    ["socks=127.0.0.1:3; HTTP = http://127.0.0.1:1", "http://127.0.0.1:1"],
    ["https=https://127.0.0.1:2", "https://127.0.0.1:2"],
  ])("selects https before http in %s", async (ProxyServer, expected) => {
    const result = await resolve({ ProxyEnable: 1, ProxyServer });
    expect(result.env.HTTPS_PROXY).toBe(expected);
    expect(result.env.HTTP_PROXY).toBe(expected);
    expect(result.env.ALL_PROXY).toBeUndefined();
  });
  it("uses ALL_PROXY for SOCKS only", async () => {
    const result = await resolve({ ProxyEnable: 1, ProxyServer: "socks=127.0.0.1:1080" });
    expect(result.env.ALL_PROXY).toBe("socks5://127.0.0.1:1080");
    expect(result.env.HTTPS_PROXY).toBeUndefined();
    expect(result.message).toBe("使用系统代理 socks5://127.0.0.1:1080");
  });
  it.each([{}, { ProxyEnable: 0, ProxyServer: "127.0.0.1:7897" }, { ProxyEnable: 1, ProxyServer: "" }])("connects directly with no enabled manual proxy: %j", async values => {
    const result = await resolve(values);
    expect(result.env.HTTPS_PROXY).toBeUndefined();
    expect(result.message).toBe("未使用代理");
  });
  it("warns about PAC without trying to evaluate or fetch it", async () => {
    const warn = vi.fn();
    const result = await resolveCodexProxy({ env: {}, serverUrl, platform: "win32", warn, queryRegistry: async () => registry({ AutoConfigURL: "http://pac.invalid/proxy.pac" }) });
    expect(result.message).toBe("未使用代理");
    expect(warn.mock.calls).toEqual([["检测到自动配置脚本代理，暂不支持，请在系统设置手动指定代理或设置 HTTPS_PROXY"]]);
  });
  it.each(["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy", "HtTpS_pRoXy"])("preserves inherited %s rather than overriding it from the registry", async name => {
    const env = { [name]: "http://existing:8118" };
    const result = await resolve({ ProxyEnable: 1, ProxyServer: "127.0.0.1:7897" }, env);
    expect(result.env[name]).toBe("http://existing:8118");
    expect(Object.keys(result.env).filter(key => /^(https?|all)_proxy$/i.test(key))).toEqual([name]);
    expect(result.message).toBe("使用环境变量代理 http://existing:8118");
    expect(env).toEqual({ [name]: "http://existing:8118" });
  });
  it("merges both NO_PROXY cases, registry bypasses and server hostname without mutating the parent", async () => {
    const env = { NO_PROXY: "existing.internal,LOCALHOST", no_proxy: "another.internal,127.0.0.1" };
    const before = { ...env };
    const result = await resolveCodexProxy({ env, serverUrl: "https://paperclip.lan:3100", platform: "win32", localHostname: "member-pc", queryRegistry: async () => registry({ ProxyEnable: 1, ProxyServer: "localhost:7897", ProxyOverride: "<local>;*.internal;192.168.*;paperclip.lan" }) });
    expect(result.env.NO_PROXY).toBe("existing.internal,LOCALHOST,another.internal,127.0.0.1,::1,member-pc,*.internal,192.168.*,paperclip.lan");
    expect(result.env.no_proxy).toBe(result.env.NO_PROXY);
    expect(env).toEqual(before);
  });
  it("merges registry overrides even when an inherited proxy wins", async () => {
    const result = await resolve({ ProxyOverride: "intranet.local" }, { HTTPS_PROXY: "http://existing:8118" });
    expect(result.env.NO_PROXY).toContain("intranet.local");
  });
  it.each(["http://alice:secret@proxy:7897", "alice:secret@proxy:7897", "http://alice%40corp:s%40cret@proxy:7897", "http://alice:secret@proxy:badport"])('never logs credentials in %s', async endpoint => {
    const result = await resolve({ ProxyEnable: 1, ProxyServer: endpoint });
    expect(result.message).toContain("***@proxy:");
    expect(result.message).not.toMatch(/alice|secret|s%40cret/);
  });
  it("re-reads registry changes on each invocation", async () => {
    let port = 7897;
    const options = { env: {}, serverUrl, platform: "win32" as const, queryRegistry: async () => registry({ ProxyEnable: 1, ProxyServer: `localhost:${port}` }) };
    expect((await resolveCodexProxy(options)).env.HTTPS_PROXY).toBe("http://localhost:7897");
    port = 7898;
    expect((await resolveCodexProxy(options)).env.HTTPS_PROXY).toBe("http://localhost:7898");
  });
  it("ignores a failed registry read, warns once without exposing error text, and keeps inherited proxies", async () => {
    const warn = vi.fn();
    const options = { env: {}, serverUrl, platform: "win32" as const, queryRegistry: async () => { throw new Error("secret"); }, warn, registryWarningState: new SharedArrayBuffer(4) };
    const result = await resolveCodexProxy(options);
    await resolveCodexProxy(options);
    expect(result.message).toBe("未使用代理");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret");
    const inherited = await resolveCodexProxy({ env: { HTTP_PROXY: "http://existing:8118" }, serverUrl, platform: "win32", queryRegistry: async () => { throw new Error(); } });
    expect(inherited.env.HTTP_PROXY).toBe("http://existing:8118");
  });
  it("does not run reg.exe on other platforms", async () => {
    const queryRegistry = vi.fn();
    const result = await resolveCodexProxy({ env: {}, serverUrl: "http://[::1]:3100", platform: "linux", queryRegistry });
    expect(queryRegistry).not.toHaveBeenCalled();
    expect(result.env.NO_PROXY).toBe("localhost,127.0.0.1,::1");
  });
  it("queries all Internet Settings once using absolute reg.exe, no shell, a 5-second timeout and hidden window", async () => {
    const run = vi.fn(async () => "registry output");
    expect(await queryWindowsProxy({ SystemRoot: "C:\\Windows" }, run)).toBe("registry output");
    expect(run).toHaveBeenCalledWith("C:\\Windows\\System32\\reg.exe", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"], { timeout: 5000, windowsHide: true, shell: false, encoding: "utf8", maxBuffer: 1024 * 1024 });
  });
});
