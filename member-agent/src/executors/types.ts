/** The server's v1 task package. Credentials remain in memory and must not be logged. */
export interface JobStart {
  v: 1;
  type: "job.start";
  jobId: string;
  companyId: string;
  agent: { id: string; name: string };
  authToken: string;
  context: Record<string, unknown>;
  config: { maxRunSec?: number };
  runtime: Record<string, unknown>;
  runtimeTools: {
    version: number;
    guidance: string;
    mcpEndpoint: string;
    rest: { connectionsSearch: string; connectionRequest: string };
    bearerToken: string;
    expiresAt: string;
    tools: readonly string[];
  } | null;
  handoffMarkdown: string;
  codeSyncDir: string;
}

export interface ExecutorHooks {
  log(stream: "stdout" | "stderr", text: string): void;
  event(event: Record<string, unknown>): void;
  meta(meta: Record<string, unknown>): void;
  usage(checkpoint: Record<string, unknown>): void;
  childSpawned(pid: number): void;
  signal: AbortSignal;
  readonly job: JobStart;
  readonly serverUrl: string;
}

export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
}

export interface Accounting {
  usage?: UsageSummary;
  usageByModel?: Array<{ model: string; usage: UsageSummary; costUsd: number }>;
  usageBasis?: "per_run" | "session_cumulative" | null;
  provider?: string | null;
  biller?: string | null;
  model?: string | null;
  billingType?: "api" | "subscription" | "metered_api" | "subscription_included" | "subscription_overage" | "credits" | "fixed" | "unknown" | null;
  costUsd?: number | null;
  costUsdExact?: string | null;
  costStatus?: "reported" | "estimated" | "unpriced";
  pricingContext?: { serviceTier?: string; contextTier?: "short" | "long" };
  pricingProvenance?: {
    source: "provider_reported" | "provider_invoice" | "operator" | "rate_card" | "unknown";
    version?: string;
    evidence?: string;
    inputCentsPerMillion?: string;
    cachedInputCentsPerMillion?: string;
    outputCentsPerMillion?: string;
    cacheWriteCentsPerMillion?: string;
    serviceTier?: string;
    contextTier?: "short" | "long";
  };
  cacheAdjustedCostUsd?: number | null;
  providerRequestId?: string | null;
}

/** Only fields accepted by member-agent/execute.ts resultSchema belong here. */
export interface ExecutorResult extends Accounting {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  errorCode?: string | null;
  errorMessage?: string | null;
  errorFamily?: "configuration" | "transient_upstream" | "provider_quota" | "model_refusal" | "refresh_token_reused" | "refresh_token_expired" | "refresh_token_invalidated" | null;
  retryNotBefore?: string | null;
  errorMeta?: Record<string, unknown>;
  summary?: string | null;
  resultJson?: Record<string, unknown> | null;
  sessionId?: string | null;
  sessionDisplayId?: string | null;
  sessionParams?: Record<string, unknown> | null;
  clearSession?: boolean;
  usageComplete?: boolean;
  executionRecovery?: { kind: "bootstrap"; providerWorkStarted: false } | {
    kind: "interrupted"; providerStopped: true; sessionPreserved: true; actionOutcomes: "settled";
  };
}

export interface Executor {
  readonly name: string;
  execute(hooks: ExecutorHooks): Promise<ExecutorResult>;
}
