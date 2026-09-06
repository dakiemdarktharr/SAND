import { describe, expect, it } from 'vitest';
import { ModelRegistry, registryConfiguration } from './registry';
import { providerIds } from './types';

const live = process.env.SAND_LIVE_REGISTRY_TESTS === '1';
const config = registryConfiguration(process.env);
const configured = {
  openai: !!config.openaiKey,
  anthropic: !!config.anthropicKey,
  gemini: !!config.geminiKey,
  openrouter: !!config.openrouterKey || !!config.openrouterPublicDiscovery,
  ollama: !!config.ollamaOrigin,
};
describe('LIVE provider discovery contracts (not inference tests)', () => {
  for (const provider of providerIds) {
    it.skipIf(!live || !configured[provider])(
      provider + ': live API discovery; skipped unless SAND_LIVE_REGISTRY_TESTS=1 and provider configuration exists',
      async () => {
        const { outcome, models } = await new ModelRegistry(config).discover(provider);
        expect(outcome.errorCode, 'live provider failure must fail the test').toBeNull();
        expect(outcome.status).toBe('available');
        expect(models.length).toBeGreaterThan(0);
        expect(models.every(model => model.source && Number.isFinite(Date.parse(model.observedAt)))).toBe(true);
        if (provider === 'openrouter') expect(models.some(model => model.pricing?.source && model.pricing.observedAt)).toBe(true);
      }, 60_000,
    );
  }
});
