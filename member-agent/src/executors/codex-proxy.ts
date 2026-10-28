import { execFile } from "node:child_process";
import { hostname } from "node:os";
import path from "node:path";

const INTERNET_SETTINGS = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
let registryWarningShown = false;
type RegistryRunner = (file: string, args: string[], options: {
  timeout: number; windowsHide: boolean; shell: false; encoding: "utf8"; maxBuffer: number;
}) => Promise<string>;
const runRegistry: RegistryRunner = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, args, options, (error, stdout) => error ? reject(error) : resolve(stdout));
});

export function queryWindowsProxy(env: NodeJS.ProcessEnv, run: RegistryRunner = runRegistry): Promise<string> {
  const systemRoot = Object.entries(env).find(([key]) => key.toLowerCase() === "systemroot")?.[1] ?? "C:\\Windows";
  return run(path.win32.join(systemRoot, "System32", "reg.exe"), ["query", INTERNET_SETTINGS], {
    timeout: 5000, windowsHide: true, shell: false, encoding: "utf8", maxBuffer: 1024 * 1024,
  });
}

interface ProxyOptions {
  env: NodeJS.ProcessEnv;
  serverUrl: string;
  platform?: NodeJS.Platform;
  queryRegistry?: () => Promise<string>;
  localHostname?: string;
  warn?: (message: string) => void;
  registryWarningState?: SharedArrayBuffer;
}

function address(value: string, protocol = "http"): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `${protocol}://${value}`;
}

export function redactProxyAddress(value: string): string {
  // Also redact malformed URLs: URL parsing must never be a prerequisite for privacy.
  const clean = value.replace(/[\x00-\x1f\x7f]/g, "");
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(clean)?.[0] ?? "";
  const at = clean.lastIndexOf("@");
  return at < 0 ? clean : `${scheme}***@${clean.slice(at + 1)}`;
}

/** Return only a child environment overlay. Never write to the caller's environment. */
export async function resolveCodexProxy(options: ProxyOptions): Promise<{ env: Record<string, string>; message: string }> {
  const env: Record<string, string> = {};
  const inherited = Object.entries(options.env).filter(([key, value]) => /^(https?|all)_proxy$/i.test(key) && value?.trim());
  for (const [key, value] of inherited) env[key] = value!;
  const registry: Record<string, string> = {};
  if ((options.platform ?? process.platform) === "win32") {
    try {
      const text = await (options.queryRegistry ?? (() => queryWindowsProxy(options.env)))();
      for (const line of text.split(/\r?\n/)) {
        const match = /^\s*(ProxyEnable|ProxyServer|ProxyOverride|AutoConfigURL)\s+REG_\w+\s+(.*?)\s*$/i.exec(line);
        if (match) registry[match[1].toLowerCase()] = match[2];
      }
    } catch {
      const first = options.registryWarningState
        ? Atomics.compareExchange(new Int32Array(options.registryWarningState), 0, 0, 1) === 0
        : !registryWarningShown;
      if (first && options.warn) {
        registryWarningShown = true;
        options.warn("读取系统代理失败，本次忽略系统代理设置。");
      }
    }
  }
  let message = inherited.length ? `使用环境变量代理 ${inherited.map(([, value]) => redactProxyAddress(value!)).join("，")}` : "未使用代理";
  if (!inherited.length) {
    if (Number(registry.proxyenable) === 1 && registry.proxyserver) {
      const raw = registry.proxyserver.trim();
      const endpoints: Record<string, string> = {};
      if (/^(?:http|https|socks)\s*=/i.test(raw) || raw.includes(";")) {
        for (const entry of raw.split(";")) {
          const match = /^\s*(https?|socks)\s*=\s*(.+?)\s*$/i.exec(entry);
          if (match) endpoints[match[1].toLowerCase()] = match[2];
        }
      } else endpoints.https = raw;
      const http = endpoints.https || endpoints.http;
      if (http) env.HTTPS_PROXY = env.HTTP_PROXY = address(http);
      else if (endpoints.socks) env.ALL_PROXY = address(endpoints.socks, "socks5");
      const selected = env.HTTPS_PROXY ?? env.ALL_PROXY;
      if (selected) message = `使用系统代理 ${redactProxyAddress(selected)}`;
    } else if (!registry.proxyserver && registry.autoconfigurl) {
      options.warn?.("检测到自动配置脚本代理，暂不支持，请在系统设置手动指定代理或设置 HTTPS_PROXY");
    }
  }
  const bypass = new Map<string, string>();
  const add = (value: string) => { const trimmed = value.trim(); if (trimmed && !bypass.has(trimmed.toLowerCase())) bypass.set(trimmed.toLowerCase(), trimmed); };
  for (const [key, value] of Object.entries(options.env)) if (/^no_proxy$/i.test(key)) value?.split(/[,;]/).forEach(add);
  ["localhost", "127.0.0.1", "::1"].forEach(add);
  for (const item of (registry.proxyoverride ?? "").split(/[;,]/)) {
    if (item.trim().toLowerCase() === "<local>") add(options.localHostname ?? hostname());
    else add(item);
  }
  add(new URL(options.serverUrl).hostname.replace(/^\[|\]$/g, ""));
  env.NO_PROXY = [...bypass.values()].join(",");
  // Keep any inherited casing in sync, as consumers disagree on casing precedence.
  for (const key of Object.keys(options.env)) if (/^no_proxy$/i.test(key)) env[key] = env.NO_PROXY;
  return { env, message };
}
