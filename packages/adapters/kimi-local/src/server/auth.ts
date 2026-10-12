import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

/**
 * config.toml exists on any configured install and is not by itself proof of
 * auth material. Only treat it as such when a [providers.*] table carries a
 * non-empty api_key (direct API-key auth) — the OAuth dirs are checked
 * separately.
 */
const PROVIDERS_TABLE_RE = /^\s*\[providers\.[^\]]+\]/m;
const PROVIDER_API_KEY_RE = /^\s*api_key\s*=\s*"[^"]+"/m;

async function configTomlHasProviderKey(configPath: string): Promise<boolean> {
  try {
    const contents = await fs.readFile(configPath, "utf8");
    return PROVIDERS_TABLE_RE.test(contents) && PROVIDER_API_KEY_RE.test(contents);
  } catch {
    return false;
  }
}

/**
 * Detect Kimi authentication material on the local host: OAuth credentials
 * under $KIMI_CODE_HOME (default ~/.kimi-code) or a config.toml with a keyed
 * provider, plus the KIMI_MODEL_NAME + KIMI_MODEL_API_KEY env pair (config
 * env or server env).
 */
export async function detectLocalKimiAuth(env: Record<string, unknown>): Promise<string | null> {
  if (
    (isNonEmpty(env.KIMI_MODEL_NAME) || isNonEmpty(process.env.KIMI_MODEL_NAME)) &&
    (isNonEmpty(env.KIMI_MODEL_API_KEY) || isNonEmpty(process.env.KIMI_MODEL_API_KEY))
  ) {
    return "KIMI_MODEL_NAME + KIMI_MODEL_API_KEY environment";
  }
  const kimiCodeHome =
    (isNonEmpty(env.KIMI_CODE_HOME) && env.KIMI_CODE_HOME.trim()) ||
    (isNonEmpty(process.env.KIMI_CODE_HOME) && process.env.KIMI_CODE_HOME.trim()) ||
    path.join(os.homedir(), ".kimi-code");
  for (const candidate of [path.join(kimiCodeHome, "credentials"), path.join(kimiCodeHome, "oauth")]) {
    if (await pathExists(candidate)) {
      return `${candidate} (kimi login OAuth)`;
    }
  }
  const configPath = path.join(kimiCodeHome, "config.toml");
  if (await configTomlHasProviderKey(configPath)) {
    return `${configPath} ([providers.*] api_key)`;
  }
  return null;
}
