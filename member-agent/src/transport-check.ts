import { BlockList, isIP } from "node:net";
import { ConfigError } from "./config.ts";

// Keep the address ranges aligned with server/src/realtime/member-agent-ws.ts.
// No server imports: this client is independently installed and run.
const allowed = new BlockList();
allowed.addSubnet("127.0.0.0", 8, "ipv4");
allowed.addAddress("::1", "ipv6");
allowed.addSubnet("10.0.0.0", 8, "ipv4");
allowed.addSubnet("100.64.0.0", 10, "ipv4");
allowed.addSubnet("172.16.0.0", 12, "ipv4");
allowed.addSubnet("192.168.0.0", 16, "ipv4");
allowed.addSubnet("169.254.0.0", 16, "ipv4");
allowed.addSubnet("fc00::", 7, "ipv6");
allowed.addSubnet("fe80::", 10, "ipv6");

export function assertTransportAllowed(serverUrl: string): void {
  let parsed: URL;
  try { parsed = new URL(serverUrl); }
  catch { throw new ConfigError(["配置错误：serverUrl 无效，请填写 http:// 或 https:// 源地址。"]); }
  if (parsed.protocol === "https:") return;
  if (parsed.protocol !== "http:") throw new ConfigError(["配置错误：serverUrl 必须使用 http:// 或 https://。"]);
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  const version = isIP(host);
  if (version && allowed.check(host, version === 4 ? "ipv4" : "ipv6")) return;
  if (!version && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(host)) return;
  throw new ConfigError(["配置错误：明文只允许用于内网，请改用 https://。"]);
}
