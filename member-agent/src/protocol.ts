import type { Accounting, ExecutorResult } from "./executors/types.ts";
export type { JobStart } from "./executors/types.ts";

export const MAX_FRAME_BYTES = 256 * 1024;
export const MAX_LOG_BYTES = 32 * 1024;

export interface Frame {
  v: 1;
  type: string;
  [key: string]: unknown;
}

export interface InvocationMeta {
  adapterType: string;
  command: string;
  cwd?: string;
  commandArgs?: string[];
  commandNotes?: string[];
  env?: Record<string, string>;
  prompt?: string;
  promptMetrics?: Record<string, number>;
  context?: Record<string, unknown>;
}

export interface RuntimeEvent {
  eventType: string;
  stream?: "system" | "stdout" | "stderr";
  level?: "info" | "warn" | "error";
  color?: string;
  message?: string;
  payload?: Record<string, unknown>;
}

export interface UsageCheckpoint extends Accounting {
  attemptId?: string;
  complete: boolean;
}

type Check = (value: unknown) => boolean;
type Shape = Record<string, Check>;
const string: Check = (value) => typeof value === "string";
const boolean: Check = (value) => typeof value === "boolean";
const number: Check = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const integer: Check = (value) => typeof value === "number" && Number.isSafeInteger(value);
const optional = (check: Check): Check => (value) => value === undefined || check(value);
const nullable = (check: Check): Check => (value) => value === null || check(value);
const literal = (expected: unknown): Check => (value) => value === expected;
const oneOf = (...values: string[]): Check => (value) => typeof value === "string" && values.includes(value);
const array = (check: Check): Check => (value) => Array.isArray(value) && value.every(check);
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const record = (check: Check = () => true): Check => (value) => {
  if (!isRecord(value)) return false;
  // z.record accepts plain records, unlike z.object (which also accepts class
  // instances); match its constructor check without importing server code.
  const constructor = value.constructor;
  if (typeof constructor === "function" && (!isRecord(constructor.prototype) || !Object.hasOwn(constructor.prototype, "isPrototypeOf"))) return false;
  return Reflect.ownKeys(value).every((key) => key === "__proto__" || !Object.prototype.propertyIsEnumerable.call(value, key)
    || (typeof key === "string" && check(value[key])));
};
const object = (shape: Shape): Check => (value) => isRecord(value)
  && Object.keys(value).every((key) => Object.hasOwn(shape, key))
  && Object.entries(shape).every(([key, check]) => check(Object.hasOwn(value, key) ? value[key] : undefined));

const usage = object({ inputTokens: number, outputTokens: number, cachedInputTokens: optional(number), cacheWriteTokens: optional(number) });
const contextTier = oneOf("short", "long");
const accounting: Shape = {
  usage: optional(usage),
  usageByModel: optional(array(object({ model: string, usage, costUsd: number }))),
  usageBasis: optional(nullable(oneOf("per_run", "session_cumulative"))),
  provider: optional(nullable(string)), biller: optional(nullable(string)), model: optional(nullable(string)),
  billingType: optional(nullable(oneOf("api", "subscription", "metered_api", "subscription_included", "subscription_overage", "credits", "fixed", "unknown"))),
  costUsd: optional(nullable(number)), costUsdExact: optional(nullable(string)),
  costStatus: optional(oneOf("reported", "estimated", "unpriced")),
  pricingContext: optional(object({ serviceTier: optional(string), contextTier: optional(contextTier) })),
  pricingProvenance: optional(object({
    source: oneOf("provider_reported", "provider_invoice", "operator", "rate_card", "unknown"),
    version: optional(string), evidence: optional(string), inputCentsPerMillion: optional(string),
    cachedInputCentsPerMillion: optional(string), outputCentsPerMillion: optional(string),
    cacheWriteCentsPerMillion: optional(string), serviceTier: optional(string), contextTier: optional(contextTier),
  })),
  cacheAdjustedCostUsd: optional(nullable(number)), providerRequestId: optional(nullable(string)),
};

// Match z.iso.datetime({ offset: true }): calendar-valid dates, optional seconds,
// arbitrary fractional precision, and only Z or an explicit ±HH:MM offset.
const isoDateTime: Check = (value) => {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]!;
};
const executionRecovery: Check = (value) => object({ kind: literal("bootstrap"), providerWorkStarted: literal(false) })(value)
  || object({ kind: literal("interrupted"), providerStopped: literal(true), sessionPreserved: literal(true), actionOutcomes: literal("settled") })(value);
const result = object({
  ...accounting, exitCode: nullable(integer), signal: nullable(string), timedOut: boolean,
  errorCode: optional(nullable(string)), errorMessage: optional(nullable(string)),
  errorFamily: optional(nullable(oneOf("configuration", "transient_upstream", "provider_quota", "model_refusal", "refresh_token_reused", "refresh_token_expired", "refresh_token_invalidated"))),
  retryNotBefore: optional(nullable(isoDateTime)), errorMeta: optional(record()),
  summary: optional(nullable(string)), resultJson: optional(nullable(record())),
  sessionId: optional(nullable(string)), sessionDisplayId: optional(nullable(string)), sessionParams: optional(nullable(record())),
  clearSession: optional(boolean), usageComplete: optional(boolean), executionRecovery: optional(executionRecovery),
});
const meta = object({
  adapterType: string, command: string, cwd: optional(string), commandArgs: optional(array(string)), commandNotes: optional(array(string)),
  env: optional(record(string)), prompt: optional(string), promptMetrics: optional(record(number)), context: optional(record()),
});
const event = object({
  eventType: string, stream: optional(oneOf("system", "stdout", "stderr")), level: optional(oneOf("info", "warn", "error")),
  color: optional(string), message: optional(string), payload: optional(record()),
});
const checkpoint = object({ ...accounting, attemptId: optional(string), complete: boolean });

function validated<T>(value: unknown, check: Check, message: string): T {
  if (!check(value)) throw new Error(message);
  return value as T;
}

/** Never include raw input in protocol errors: frames can contain credentials. */
export function parseFrame(bytes: Buffer | string, binary = false): Frame {
  if (binary) throw new Error("协议错误：只接受 UTF-8 文本帧");
  if (Buffer.byteLength(bytes) > MAX_FRAME_BYTES) throw new Error("协议错误：消息超过 256 KB");
  let value: unknown;
  try {
    const text = typeof bytes === "string" ? bytes : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    throw new Error("协议错误：消息不是有效的 UTF-8 JSON");
  }
  if (!isRecord(value) || value.v !== 1 || typeof value.type !== "string") throw new Error("协议错误：消息必须包含 v: 1 和字符串 type");
  return value as Frame;
}

export function validateResult(value: unknown): ExecutorResult {
  return validated(value, result, "协议错误：运行结果含未知字段或字段无效");
}

export function validateMeta(value: unknown): InvocationMeta {
  return validated(value, meta, "协议错误：调用元数据含未知字段或字段无效");
}

export function validateEvent(value: unknown): RuntimeEvent {
  return validated(value, event, "协议错误：运行事件含未知字段或字段无效");
}

export function validateUsage(value: unknown): UsageCheckpoint {
  return validated(value, checkpoint, "协议错误：用量消息含未知字段或字段无效");
}

export function chunkUtf8(text: string, maxBytes = MAX_LOG_BYTES): string[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("日志分块字节上限必须是正整数");
  const chunks: string[] = [];
  let pending: string[] = [], size = 0;
  for (const character of text) {
    const bytes = Buffer.byteLength(character);
    if (bytes > maxBytes) throw new Error("日志分块字节上限无法容纳一个完整字符");
    if (size + bytes > maxBytes) { chunks.push(pending.join("")); pending = []; size = 0; }
    pending.push(character); size += bytes;
  }
  if (pending.length) chunks.push(pending.join(""));
  return chunks;
}
