import { it, expect } from 'vitest';
import { TextInference } from './inference';
import { createTemplate, type StudioNode } from './schema';
const providers: StudioNode['provider'][] = [
  'ollama',
  'openai',
  'openrouter',
  'anthropic',
  'gemini',
];
const keys: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
};
for (const provider of providers) {
  const model = process.env['SAND_TEST_' + provider.toUpperCase() + '_MODEL'];
  const enabled =
    process.env.SAND_LIVE_INFERENCE_TESTS === '1' &&
    !!model &&
    (provider === 'ollama' || !!process.env[keys[provider]!]);
  it.skipIf(!enabled)(
    provider +
      ': REAL inference; requires explicit live-test flag, model ID and provider credential',
    async () => {
      const node = {
        ...createTemplate().nodes[0]!,
        provider,
        model: model!,
        maxOutputTokens: 64,
        instructions: 'Reply with a short greeting. No tool calls.',
      };
      const output = await new TextInference().run(node, 'Hello', AbortSignal.timeout(180000));
      expect(output.text.trim().length).toBeGreaterThan(0);
      expect(output.provider).toBe(provider);
      expect(Number.isFinite(Date.parse(output.observedAt))).toBe(true);
    },
    180000,
  );
}
