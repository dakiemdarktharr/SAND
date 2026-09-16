import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { StudioRuntime } from './runtime';
import { createTemplate, definitionSchema, type StudioNode, type InferenceResult } from './schema';
import type { AgentRunner } from './inference';

// Deterministic inference doubles are confined to tests. Production uses TextInference only.
const result = (node: StudioNode): InferenceResult => ({
  text: 'Unit-test output for ' + node.id,
  provider: node.provider,
  requestedModel: node.model,
  reportedModel: node.model,
  inputTokens: 1,
  outputTokens: 2,
  durationMs: 1,
  costUsd: null,
  costSource: null,
  observedAt: new Date().toISOString(),
  truncated: false,
});
const definition = () => {
  const d = createTemplate();
  d.nodes = d.nodes.map((n) => (n.kind === 'agent' ? { ...n, model: 'unit-test-model' } : n));
  return d;
};
const instances: StudioRuntime[] = [];
function runtime(runner: AgentRunner = { run: async (n) => result(n) }, file = ':memory:') {
  const r = new StudioRuntime(file, runner);
  instances.push(r);
  return r;
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('Expected state not reached');
}
afterEach(() => {
  for (const r of instances.splice(0)) r.close();
});

describe('Workflow Studio local durable DAG', () => {
  it('counts paused in-flight requests and rechecks admission when resuming', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const r = runtime({
      run: async (n) => {
        await gate;
        return result(n);
      },
    });
    const ids = Array.from(
      { length: 3 },
      (_, i) => r.start(definition(), 'Text', false, 'admission-' + i).id,
    );
    for (const id of ids) r.command(id, 'pause');
    expect(() => r.start(definition(), 'Text', false, 'admission-blocked')).toThrow('Tối đa 3');
    release();
    await until(() =>
      ids.every((id) => r.get(id).nodes.filter((n) => n.state === 'completed').length === 2),
    );
    for (let i = 0; i < 3; i++) r.start(definition(), 'Text', false, 'admission-new-' + i);
    expect(() => r.command(ids[0]!, 'resume')).toThrow('Tối đa 3');
    expect(r.get(ids[0]!).status).toBe('paused');
  });
  it('runs two independent agents concurrently, joins, blocks at review and exports only after approval', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const call = vi.fn(async (n: StudioNode) => {
      if (n.id !== 'synthesis') await gate;
      return result(n);
    });
    const r = runtime({ run: call });
    const run = r.start(definition(), 'Public test document', false, 'parallel-test');
    expect(call).toHaveBeenCalledTimes(2);
    expect(r.get(run.id).nodes.filter((n) => n.state === 'running')).toHaveLength(2);
    expect(() => r.artifact(run.id)).toThrow('chưa hoàn tất');
    release();
    await until(() => r.get(run.id).status === 'waiting');
    expect(call).toHaveBeenCalledTimes(3);
    expect(r.get(run.id).nodes.find((n) => n.id === 'report')?.state).toBe('pending');
    r.review(run.id, 'review', true);
    r.review(run.id, 'review', true);
    expect(r.get(run.id).status).toBe('completed');
    expect(r.artifact(run.id)).toContain('Unit-test output for synthesis');
    expect(r.verify(run.id).valid).toBe(true);
    expect(r.get(run.id).events.filter((e) => e.type === 'review.approved')).toHaveLength(1);
  });
  it('persists human review and stable audit across close/reopen without rerunning completed inference', async () => {
    mkdirSync('.runtime', { recursive: true });
    const file = path.join(mkdtempSync(path.resolve('.runtime/studio-test-')), 'studio.sqlite');
    const call = vi.fn(async (n: StudioNode) => result(n));
    const r = runtime({ run: call }, file);
    const graph = r.save(definition());
    const first = r.start(graph, 'Public document', false, 'persist-test');
    await until(() => r.get(first.id).status === 'waiting');
    const events = r.get(first.id).events;
    r.close();
    const reopened = runtime({ run: call }, file);
    expect(reopened.definitions()[0]).toEqual(graph);
    expect(reopened.get(first.id).events).toEqual(events);
    expect(reopened.start(graph, 'Public document', false, 'persist-test').id).toBe(first.id);
    reopened.review(first.id, 'review', true);
    expect(call).toHaveBeenCalledTimes(3);
    expect(reopened.get(first.id).status).toBe('completed');
    expect(reopened.verify(first.id).valid).toBe(true);
  });
  it('recovers interrupted calls only after explicit resume, preserving completed checkpoints', async () => {
    mkdirSync('.runtime', { recursive: true });
    const file = path.join(
      mkdtempSync(path.resolve('.runtime/studio-interrupt-')),
      'studio.sqlite',
    );
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const original = runtime(
      {
        run: async (n) => {
          if (n.id === 'critic') await gate;
          return result(n);
        },
      },
      file,
    );
    const run = original.start(definition(), 'Document', false, 'interrupt-test');
    await until(
      () => original.get(run.id).nodes.find((n) => n.id === 'analyst')?.state === 'completed',
    );
    original.close();
    release();
    const call = vi.fn(async (n: StudioNode) => result(n));
    const reopened = runtime({ run: call }, file);
    expect(reopened.get(run.id).status).toBe('interrupted');
    expect(call).not.toHaveBeenCalled();
    reopened.command(run.id, 'resume');
    await until(() => reopened.get(run.id).status === 'waiting');
    expect(call.mock.calls.map((c) => c[0].id)).toEqual(['critic', 'synthesis']);
    expect(reopened.get(run.id).nodes.find((n) => n.id === 'analyst')?.attempt).toBe(1);
  });
  it('denies cloud transmission without run consent before calling a provider', () => {
    const call = vi.fn(async (n: StudioNode) => result(n));
    const r = runtime({ run: call });
    const graph = definition();
    graph.nodes[0]!.provider = 'openai';
    const run = r.start(graph, 'Confidential input stays here', false, 'cloud-denial');
    expect(run.status).toBe('failed');
    expect(call).not.toHaveBeenCalled();
    expect(run.events.some((e) => e.type === 'policy.denied')).toBe(true);
  });
  it('fences late provider completions after cancellation and emits no artifact', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const r = runtime({
      run: async (n) => {
        await gate;
        return result(n);
      },
    });
    const run = r.start(definition(), 'Test', false, 'cancel-test');
    r.command(run.id, 'cancel');
    release();
    await new Promise((r) => setTimeout(r, 15));
    expect(r.get(run.id).status).toBe('cancelled');
    expect(r.get(run.id).nodes.every((n) => n.output === null)).toBe(true);
    expect(() => r.artifact(run.id)).toThrow();
    expect(r.verify(run.id).valid).toBe(true);
  });
  it('denying review stops downstream execution', async () => {
    const r = runtime();
    const run = r.start(definition(), 'Text', false, 'reject-test');
    await until(() => r.get(run.id).status === 'waiting');
    r.review(run.id, 'review', false);
    expect(r.get(run.id).status).toBe('cancelled');
    expect(r.get(run.id).nodes.find((n) => n.id === 'report')?.state).toBe('pending');
  });
  it('rejects graph cycles and missing dependencies', () => {
    const d = definition();
    d.nodes[0]!.dependsOn = ['report'];
    expect(definitionSchema.safeParse(d).success).toBe(false);
    d.nodes[0]!.dependsOn = ['absent'];
    expect(definitionSchema.safeParse(d).success).toBe(false);
  });
  it('rejects stale saves and idempotency-key reuse with changed input', () => {
    const r = runtime({ run: () => new Promise(() => {}) });
    const d = definition();
    const saved = r.save(d);
    expect(() => r.save(d)).toThrow('đã thay đổi');
    const run = r.start(saved, 'A', false, 'repeat-operation');
    expect(r.start(saved, 'A', false, 'repeat-operation').id).toBe(run.id);
    expect(() => r.start(saved, 'B', false, 'repeat-operation')).toThrow('dữ liệu khác');
  });
  it('blocks recognizable credentials and validates empty model configuration', () => {
    const r = runtime();
    expect(() => r.start(definition(), 'sk-' + 'x'.repeat(32), false, 'secret-test')).toThrow(
      'credential',
    );
    expect(() => r.start(createTemplate(), 'Text', false, 'model-test')).toThrow('model');
  });
  it('pause permits in-flight completion but starts no downstream node until resume', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const call = vi.fn(async (n: StudioNode) => {
      await gate;
      return result(n);
    });
    const r = runtime({ run: call });
    const run = r.start(definition(), 'Text', false, 'pause-test');
    r.command(run.id, 'pause');
    release();
    await until(() => r.get(run.id).nodes.filter((n) => n.state === 'completed').length === 2);
    expect(call).toHaveBeenCalledTimes(2);
    r.command(run.id, 'resume');
    await until(() => r.get(run.id).status === 'waiting');
    expect(call).toHaveBeenCalledTimes(3);
  });
});
