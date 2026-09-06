import { RegistryNetworkBroker, validateDestination } from './network';
import { ProviderError, providerIds, type DiscoveryResult, type JsonTransport, type ModelRecord, type ProviderId, type ProviderOutcome } from './types';

export interface RegistryConfiguration {
  openaiKey?: string;
  anthropicKey?: string;
  geminiKey?: string;
  openrouterKey?: string;
  openrouterPublicDiscovery?: boolean;
  ollamaOrigin?: string;
}
export function registryConfiguration(env: NodeJS.ProcessEnv): RegistryConfiguration {
  const configuration: RegistryConfiguration = {
    openaiKey: env.OPENAI_API_KEY,
    anthropicKey: env.ANTHROPIC_API_KEY,
    geminiKey: env.GEMINI_API_KEY,
    openrouterKey: env.OPENROUTER_API_KEY,
    openrouterPublicDiscovery: env.SAND_OPENROUTER_PUBLIC_DISCOVERY === '1',
  };
  if (env.SAND_OLLAMA_ORIGIN) {
    const url = new URL(env.SAND_OLLAMA_ORIGIN);
    if (url.origin !== env.SAND_OLLAMA_ORIGIN || url.hostname !== '127.0.0.1' || url.protocol !== 'http:') throw new ProviderError('LOCAL_MODEL_DESTINATION_DENIED');
    configuration.ollamaOrigin = url.origin;
  }
  return configuration;
}
const sources: Record<ProviderId, string> = {
  openai: 'https://api.openai.com/v1/models',
  anthropic: 'https://api.anthropic.com/v1/models',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/models',
  openrouter: 'https://openrouter.ai/api/v1/models',
  ollama: 'http://127.0.0.1:11434/api/tags',
};
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || !value || Array.isArray(value)) throw new ProviderError('INVALID_PROVIDER_RESPONSE');
  return value as Record<string, unknown>;
}
function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && [...value].every(char => char.charCodeAt(0) >= 32) ? value : null;
}
function integer(value: unknown): number | null { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null; }
function strings(value: unknown): string[] | null { return Array.isArray(value) && value.every(item => text(item) !== null) ? value as string[] : null; }
function price(value: unknown): string | null {
  return typeof value === 'string' && /^(?:0|[1-9]\d*)(?:\.\d+)?(?:e-?\d+)?$/i.test(value) && Number.isFinite(Number(value)) && Number(value) >= 0 ? value : null;
}
function base(provider: ProviderId, modelId: string, source: string, at: string): ModelRecord {
  return {
    provider, modelId, displayName: modelId, aliases: [], version: null, lifecycle: 'unknown', deprecationDate: null,
    source, observedAt: at, inputModalities: null, outputModalities: null, contextWindow: null, maximumOutputTokens: null,
    capabilities: { toolCalling: null, parallelTools: null, structuredOutput: null, vision: null, audio: null, reasoning: null, streaming: null, promptCaching: null },
    pricing: null, supportedRegions: null, dataRetentionPolicy: null, zeroDataRetention: null, rateLimits: null,
    health: 'unknown', rollingLatencyMs: null, errorRate: null,
  };
}
export function normalizeModel(provider: ProviderId, input: unknown, source: string, at: string): ModelRecord {
  const row = object(input);
  const id = text(provider === 'gemini' ? row.name : provider === 'ollama' ? row.name ?? row.model : row.id);
  if (!id) throw new ProviderError('INVALID_MODEL_ID');
  const model = base(provider, id, source, at);
  model.displayName = text(row.displayName ?? row.display_name ?? (provider === 'openrouter' ? row.name : null)) ?? id;
  if (provider === 'gemini') {
    model.contextWindow = integer(row.inputTokenLimit);
    model.maximumOutputTokens = integer(row.outputTokenLimit);
    model.version = text(row.version);
    model.capabilities.reasoning = typeof row.thinking === 'boolean' ? row.thinking : null;
  }
  if (provider === 'anthropic') {
    model.contextWindow = integer(row.max_input_tokens);
    model.maximumOutputTokens = integer(row.max_tokens);
    // Capability objects are versioned by the provider; do not guess mappings from model names.
  }
  if (provider === 'ollama') model.version = text(row.digest);
  if (provider === 'openrouter') {
    model.contextWindow = integer(row.context_length);
    const top = row.top_provider ? object(row.top_provider) : null;
    model.maximumOutputTokens = top ? integer(top.max_completion_tokens) : null;
    const architecture = row.architecture ? object(row.architecture) : null;
    if (architecture) {
      model.inputModalities = strings(architecture.input_modalities);
      model.outputModalities = strings(architecture.output_modalities);
      model.capabilities.vision = model.inputModalities?.includes('image') ?? null;
      model.capabilities.audio = model.inputModalities?.includes('audio') ?? null;
    }
    const supported = strings(row.supported_parameters);
    if (supported) {
      model.capabilities.toolCalling = supported.includes('tools');
      model.capabilities.parallelTools = supported.includes('parallel_tool_calls');
      model.capabilities.structuredOutput = supported.includes('structured_outputs');
      model.capabilities.reasoning = supported.includes('reasoning') || supported.includes('reasoning_effort');
    }
    if (row.pricing) {
      const p = object(row.pricing);
      model.pricing = {
        inputPerToken: price(p.prompt), outputPerToken: price(p.completion),
        cachedInputPerToken: price(p.input_cache_read), requestPrice: price(p.request), webSearchPrice: price(p.web_search),
        currency: 'USD', source, observedAt: at, basis: 'catalog-lowest-listed-price',
      };
    }
  }
  return model;
}
export class ModelRegistry {
  private readonly transport: JsonTransport;
  constructor(private readonly config: RegistryConfiguration, transport?: JsonTransport) {
    this.transport = transport ?? new RegistryNetworkBroker(config.ollamaOrigin);
  }
  async discover(provider: ProviderId, signal?: AbortSignal): Promise<{ models: ModelRecord[]; outcome: ProviderOutcome }> {
    const source = provider === 'ollama' ? (this.config.ollamaOrigin ?? 'http://127.0.0.1:11434') + '/api/tags' : sources[provider];
    const at = new Date().toISOString();
    const outcome: ProviderOutcome = { provider, status: 'unconfigured', source, observedAt: at, modelCount: 0, latencyMs: null, errorCode: null, retryAfterMs: null, inferenceVerified: false };
    const key = provider === 'openai' ? this.config.openaiKey : provider === 'anthropic' ? this.config.anthropicKey : provider === 'gemini' ? this.config.geminiKey : this.config.openrouterKey;
    const configured = provider === 'ollama' ? !!this.config.ollamaOrigin : provider === 'openrouter' ? !!key || this.config.openrouterPublicDiscovery : !!key;
    if (!configured) return { models: [], outcome };
    const headers: Record<string, string> = {};
    if (provider === 'anthropic' && key) { headers['x-api-key'] = key; headers['anthropic-version'] = '2023-06-01'; }
    else if (provider === 'gemini' && key) headers['x-goog-api-key'] = key;
    else if (provider !== 'ollama' && key) headers.authorization = 'Bearer ' + key;
    const started = performance.now();
    try {
      const models: ModelRecord[] = [];
      let next = source;
      const cursors = new Set<string>();
      for (let page = 0; page < 100; page++) {
        validateDestination(next, this.config.ollamaOrigin);
        const body = object(await this.transport.get(next, headers, signal));
        const rows = provider === 'gemini' || provider === 'ollama' ? body.models : body.data;
        if (!Array.isArray(rows)) throw new ProviderError('INVALID_PROVIDER_RESPONSE');
        for (const row of rows) models.push(normalizeModel(provider, row, source, at));
        if (models.length > 20_000) throw new ProviderError('MODEL_COUNT_LIMIT');
        let cursor: string | null = null;
        if (provider === 'anthropic' && body.has_more === true) {
          cursor = text(body.last_id);
          if (!cursor) throw new ProviderError('INVALID_PAGE_CURSOR');
          next = source + '?limit=1000&after_id=' + encodeURIComponent(cursor);
        } else if (provider === 'gemini' && body.nextPageToken) {
          cursor = text(body.nextPageToken);
          if (!cursor) throw new ProviderError('INVALID_PAGE_CURSOR');
          next = source + '?pageSize=1000&pageToken=' + encodeURIComponent(cursor);
        }
        if (!cursor) {
          const unique = new Map(models.map(model => [model.modelId, model]));
          return { models: [...unique.values()], outcome: { ...outcome, status: 'available', modelCount: unique.size, latencyMs: Math.round(performance.now() - started) } };
        }
        if (cursors.has(cursor)) throw new ProviderError('REPEATED_PAGE_CURSOR');
        cursors.add(cursor);
      }
      throw new ProviderError('PAGE_LIMIT_EXCEEDED');
    } catch (error) {
      if (signal?.aborted) throw new ProviderError('CANCELLED');
      const safe = error instanceof ProviderError ? error : new ProviderError('PROVIDER_DISCOVERY_FAILED');
      return { models: [], outcome: { ...outcome, status: 'error', errorCode: safe.code, retryAfterMs: safe.retryAfterMs, latencyMs: Math.round(performance.now() - started) } };
    }
  }
  async refresh(signal?: AbortSignal): Promise<DiscoveryResult> {
    const results = await Promise.all(providerIds.map(provider => this.discover(provider, signal)));
    return { models: results.flatMap(result => result.models), outcomes: results.map(result => result.outcome) };
  }
}
