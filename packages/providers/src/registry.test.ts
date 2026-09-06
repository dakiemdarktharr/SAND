import { describe, expect, it } from 'vitest';
import { ModelRegistry, normalizeModel, registryConfiguration } from './registry';
import { ProviderError, type JsonTransport } from './types';
import { isPublicAddress, retryAfter, validateDestination } from './network';

const at = '2026-09-07T00:00:00.000Z';
describe('registry normalization', () => {
  it('preserves unknown capabilities/pricing instead of deriving from a model name', () => {
    const model = normalizeModel('openai', { id: 'future-reasoning-vision-model' }, 'https://api.openai.com/v1/models', at);
    expect(model.contextWindow).toBeNull();
    expect(model.capabilities.vision).toBeNull();
    expect(model.pricing).toBeNull();
    expect(model.observedAt).toBe(at);
    expect(model.health).toBe('unknown');
  });
  it('records source and timestamp for per-token OpenRouter prices without silently treating missing price as zero', () => {
    const model = normalizeModel('openrouter', {
      id: 'vendor/test-model', name: 'Test model', context_length: 12345,
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
      pricing: { prompt: '0.000002', completion: '0.000008', input_cache_read: '-1' },
      supported_parameters: ['tools', 'structured_outputs'],
    }, 'https://openrouter.ai/api/v1/models', at);
    expect(model.pricing).toMatchObject({ inputPerToken: '0.000002', cachedInputPerToken: null, currency: 'USD', source: 'https://openrouter.ai/api/v1/models', observedAt: at });
    expect(model.capabilities).toMatchObject({ toolCalling: true, vision: true, streaming: null });
    expect(model.maximumOutputTokens).toBeNull();
  });
  it('reads Gemini limits from API fields', () => {
    expect(normalizeModel('gemini', { name: 'models/new', inputTokenLimit: 1024, outputTokenLimit: 256 }, 'source', at))
      .toMatchObject({ modelId: 'models/new', contextWindow: 1024, maximumOutputTokens: 256 });
  });
  it('rejects malformed model IDs and public arbitrary Ollama targets', () => {
    expect(() => normalizeModel('openai', { id: '../x\n' }, 'source', at)).toThrow('INVALID_MODEL_ID');
    expect(() => registryConfiguration({ SAND_OLLAMA_ORIGIN: 'http://169.254.169.254' })).toThrow();
    expect(() => registryConfiguration({ SAND_OLLAMA_ORIGIN: 'http://localhost:11434' })).toThrow();
    expect(() => registryConfiguration({ SAND_OLLAMA_ORIGIN: 'http://127.0.0.1:11434/path' })).toThrow();
  });
});

describe('real adapter request contracts with unit-only transport fixtures', () => {
  it('never contacts the network when unconfigured', async () => {
    const transport: JsonTransport = { async get() { throw new Error('network must not be used'); } };
    const result = await new ModelRegistry({}, transport).refresh();
    expect(result.models).toEqual([]);
    expect(result.outcomes).toHaveLength(5);
    expect(result.outcomes.every(outcome => outcome.status === 'unconfigured')).toBe(true);
  });
  it('paginates Anthropic using opaque encoded cursor and keeps credential out of URLs and results', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const transport: JsonTransport = { async get(url, headers) {
      calls.push({ url, headers });
      return calls.length === 1 ? { data: [{ id: 'first' }], has_more: true, last_id: 'first/?&' } : { data: [{ id: 'second' }], has_more: false };
    } };
    const result = await new ModelRegistry({ anthropicKey: 'unit-test-secret' }, transport).discover('anthropic');
    expect(calls[1]?.url).toContain('after_id=first%2F%3F%26');
    expect(calls[0]?.headers['x-api-key']).toBe('unit-test-secret');
    expect(result.models).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain('unit-test-secret');
  });
  it('uses Gemini header authentication rather than key query parameter', async () => {
    const transport: JsonTransport = { async get(url, headers) {
      expect(url).not.toContain('unit-test-secret');
      expect(headers['x-goog-api-key']).toBe('unit-test-secret');
      return { models: [{ name: 'models/unit' }] };
    } };
    expect((await new ModelRegistry({ geminiKey: 'unit-test-secret' }, transport).discover('gemini')).outcome.status).toBe('available');
  });
  it('returns safe errors without partial catalog or provider error body', async () => {
    const transport: JsonTransport = { async get() { throw new Error('Bearer unit-test-secret echoed upstream'); } };
    const result = await new ModelRegistry({ openaiKey: 'unit-test-secret' }, transport).discover('openai');
    expect(result.models).toEqual([]);
    expect(result.outcome).toMatchObject({ status: 'error', errorCode: 'PROVIDER_DISCOVERY_FAILED' });
    expect(JSON.stringify(result)).not.toContain('unit-test-secret');
  });
  it('maps rate-limit delay and detects repeated pagination', async () => {
    const rate: JsonTransport = { async get() { throw new ProviderError('RATE_LIMITED', true, 3000); } };
    expect((await new ModelRegistry({ openaiKey: 'test' }, rate).discover('openai')).outcome.retryAfterMs).toBe(3000);
    const pages: JsonTransport = { async get() { return { data: [{ id: 'first' }], has_more: true, last_id: 'same' }; } };
    expect((await new ModelRegistry({ anthropicKey: 'test' }, pages).discover('anthropic')).outcome.errorCode).toBe('REPEATED_PAGE_CURSOR');
  });
  it('propagates cancellation as cancellation, never a successful empty registry', async () => {
    const controller = new AbortController();
    controller.abort();
    const transport: JsonTransport = { async get() { throw new Error('aborted'); } };
    await expect(new ModelRegistry({ openaiKey: 'test' }, transport).discover('openai', controller.signal)).rejects.toThrow('CANCELLED');
  });
});

describe('fixed-origin egress policy', () => {
  it.each(['127.0.0.1', '0.0.0.0', '10.1.1.1', '169.254.169.254', '172.31.1.1', '192.168.1.1', '100.64.0.1', '224.1.1.1', '::1', '::ffff:127.0.0.1', 'fc00::1', '2001:db8::1', '64:ff9b::a00:1'])('blocks special-use/private IP %s', address => {
    expect(isPublicAddress(address)).toBe(false);
  });
  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('permits globally routable address %s', address => expect(isPublicAddress(address)).toBe(true));
  it.each(['https://api.openai.com.evil.test/v1/models', 'http://api.openai.com/v1/models', 'https://api.openai.com:444/', 'https://user:pass@api.openai.com/', 'file:///etc/passwd', 'http://127.0.0.1:11434/api/tags'])('denies destination %s without an explicit local scope', value => {
    expect(() => validateDestination(value)).toThrow('NETWORK_DESTINATION_DENIED');
  });
  it('allows only the exact configured local origin', () => {
    expect(validateDestination('http://127.0.0.1:11434/api/tags', 'http://127.0.0.1:11434').origin).toBe('http://127.0.0.1:11434');
    expect(() => validateDestination('http://127.0.0.1:4310/', 'http://127.0.0.1:11434')).toThrow();
  });
  it('bounds retry-after for malformed, delta and HTTP-date values', () => {
    expect(retryAfter('4')).toBe(4000);
    expect(retryAfter('99999999')).toBe(300000);
    expect(retryAfter('bad')).toBeNull();
    expect(retryAfter('Mon, 07 Sep 2026 00:00:03 GMT', Date.parse(at))).toBe(3000);
  });
});
