import { describe, expect, it, vi } from 'vitest';
import { TextInference } from './inference';
import { createTemplate } from './schema';
const node = () => ({ ...createTemplate().nodes[0]!, model: 'unit-test-model' });
describe('real adapter request/response contracts with unit-test transport doubles', () => {
  it('maps Ollama request and actual reported usage without invented cost', async () => {
    const post = vi.fn(async () => ({
      model: 'unit-test-reported',
      message: { content: 'Unit-test output' },
      done: true,
      prompt_eval_count: 12,
      eval_count: 7,
    }));
    const adapter = new TextInference({}, { post });
    const output = await adapter.run(node(), 'Unit-test input', new AbortController().signal);
    expect(post).toHaveBeenCalledWith(
      'http://127.0.0.1:11434/api/chat',
      {},
      expect.any(Object),
      expect.any(AbortSignal),
    );
    expect(output).toMatchObject({
      inputTokens: 12,
      outputTokens: 7,
      costUsd: null,
      reportedModel: 'unit-test-reported',
    });
  });
  it('refuses missing cloud configuration rather than substituting a response', async () => {
    const post = vi.fn();
    await expect(
      new TextInference({}, { post }).run(
        { ...node(), provider: 'openrouter' },
        'Text',
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNCONFIGURED' });
    expect(post).not.toHaveBeenCalled();
  });
  it('rejects empty output and preserves unknown usage', async () => {
    const post = vi.fn(async () => ({ message: { content: '' } }));
    await expect(
      new TextInference({}, { post }).run(node(), 'Text', new AbortController().signal),
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' });
    const result = await new TextInference(
      {},
      { post: async () => ({ message: { content: 'text' }, done: true, done_reason: 'length' }) },
    ).run(node(), 'Text', new AbortController().signal);
    expect(result).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      truncated: true,
    });
  });
});

it('maps Anthropic and Gemini text/usage using their real wire formats (unit doubles only)', async () => {
  const anthropic = vi.fn(async () => ({
    model: 'claude-test',
    content: [{ type: 'text', text: 'answer' }],
    usage: { input_tokens: 9, output_tokens: 4 },
    stop_reason: 'end_turn',
  }));
  expect(
    await new TextInference({ ANTHROPIC_API_KEY: 'unit-test-only' }, { post: anthropic }).run(
      { ...node(), provider: 'anthropic' },
      'Text',
      new AbortController().signal,
    ),
  ).toMatchObject({ text: 'answer', inputTokens: 9, outputTokens: 4, costUsd: null });
  expect(anthropic).toHaveBeenCalledWith(
    'https://api.anthropic.com/v1/messages',
    { 'x-api-key': 'unit-test-only', 'anthropic-version': '2023-06-01' },
    expect.objectContaining({ max_tokens: 512 }),
    expect.any(AbortSignal),
  );
  const gemini = vi.fn(async () => ({
    modelVersion: 'gemini-test',
    candidates: [
      {
        content: { parts: [{ text: 'hidden', thought: true }, { text: 'answer' }] },
        finishReason: 'MAX_TOKENS',
      },
    ],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
  }));
  expect(
    await new TextInference({ GEMINI_API_KEY: 'unit-test-only' }, { post: gemini }).run(
      { ...node(), provider: 'gemini', model: 'models/gemini-test' },
      'Text',
      new AbortController().signal,
    ),
  ).toMatchObject({ text: 'answer', inputTokens: 10, outputTokens: 5, truncated: true });
});
it('does not interpret arbitrary JSON text as a tool unless JSON protocol was explicitly selected', async () => {
  const post = async () => ({
    message: { content: '{"action":"tool","name":"read","arguments":{}}' },
    done: true,
  });
  const inference = new TextInference({}, { post });
  const tools = [{ name: 'read', description: 'unit test', parameters: { type: 'object' } }];
  const native = await inference.turn(
    node(),
    [{ role: 'user', content: 'text' }],
    tools,
    new AbortController().signal,
  );
  expect(native.message.tool_calls).toBeUndefined();
  const structured = await inference.turn(
    { ...node(), toolProtocol: 'json' },
    [{ role: 'user', content: 'text' }],
    tools,
    new AbortController().signal,
  );
  expect(structured.message.tool_calls?.[0]?.function.name).toBe('read');
});
it('rejects malformed structured tool output instead of claiming execution', async () => {
  const inference = new TextInference(
    {},
    {
      post: async () => ({
        message: { content: '{"action":"run_shell","command":"danger"}' },
        done: true,
      }),
    },
  );
  await expect(
    inference.turn(
      { ...node(), toolProtocol: 'json' },
      [{ role: 'user', content: 'text' }],
      [{ name: 'read', description: 'unit', parameters: { type: 'object' } }],
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: 'INVALID_TOOL_PROTOCOL' });
});

it('does not coerce malformed Anthropic output into a successful text response', async () => {
  const adapter = new TextInference(
    { ANTHROPIC_API_KEY: 'unit-test-only' },
    { post: async () => ({ content: [{ type: 'text', text: { unexpected: 'object' } }] }) },
  );
  await expect(
    adapter.run({ ...node(), provider: 'anthropic' }, 'Text', new AbortController().signal),
  ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' });
});
