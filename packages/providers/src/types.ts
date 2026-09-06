export const providerIds = ['openai', 'anthropic', 'gemini', 'openrouter', 'ollama'] as const;
export type ProviderId = (typeof providerIds)[number];
export type UnknownBoolean = boolean | null;
export interface ModelRecord {
  provider: ProviderId;
  modelId: string;
  displayName: string;
  aliases: string[];
  version: string | null;
  lifecycle: 'unknown';
  deprecationDate: string | null;
  source: string;
  observedAt: string;
  inputModalities: string[] | null;
  outputModalities: string[] | null;
  contextWindow: number | null;
  maximumOutputTokens: number | null;
  capabilities: {
    toolCalling: UnknownBoolean;
    parallelTools: UnknownBoolean;
    structuredOutput: UnknownBoolean;
    vision: UnknownBoolean;
    audio: UnknownBoolean;
    reasoning: UnknownBoolean;
    streaming: UnknownBoolean;
    promptCaching: UnknownBoolean;
  };
  pricing: null | {
    inputPerToken: string | null;
    outputPerToken: string | null;
    cachedInputPerToken: string | null;
    requestPrice: string | null;
    webSearchPrice: string | null;
    currency: 'USD';
    source: string;
    observedAt: string;
    basis: 'catalog-lowest-listed-price';
  };
  supportedRegions: string[] | null;
  dataRetentionPolicy: string | null;
  zeroDataRetention: UnknownBoolean;
  rateLimits: null;
  health: 'unknown';
  rollingLatencyMs: null;
  errorRate: null;
}
export interface ProviderOutcome {
  provider: ProviderId;
  status: 'available' | 'unconfigured' | 'error';
  source: string;
  observedAt: string;
  modelCount: number;
  latencyMs: number | null;
  errorCode: string | null;
  retryAfterMs: number | null;
  inferenceVerified: false;
}
export interface DiscoveryResult {
  models: ModelRecord[];
  outcomes: ProviderOutcome[];
}
export class ProviderError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable = false,
    public readonly retryAfterMs: number | null = null,
  ) {
    super(code);
    this.name = 'ProviderError';
  }
}
export interface JsonTransport {
  get(url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<unknown>;
}
