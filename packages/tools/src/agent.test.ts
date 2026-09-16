import { it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ToolJournal, digest } from './journal';
import { GovernedAgent, type ExecutableTool } from './agent';
import { StudioRuntime } from '../../studio/src/runtime';
import { createTemplate, type InferenceResult, type StudioNode } from '../../studio/src/schema';
import type { ToolTurn, ModelMessage } from '../../studio/src/inference';
import { RepositoryBroker } from '../../../apps/desktop/src/repository';
import { DesktopTools } from '../../../apps/desktop/src/tools';
const result = (text: string): InferenceResult => ({
  text,
  provider: 'ollama',
  requestedModel: 'unit-model',
  reportedModel: 'unit-model',
  inputTokens: 4,
  outputTokens: 3,
  durationMs: 1,
  costUsd: null,
  costSource: null,
  observedAt: new Date().toISOString(),
  truncated: false,
});
const call = (name: string, args: unknown): ToolTurn => ({
  result: result(''),
  message: {
    role: 'assistant',
    content: '',
    tool_calls: [
      { id: 'test-call', type: 'function', function: { name, arguments: JSON.stringify(args) } },
    ],
  },
});
const final: ToolTurn = {
  result: result('Test-only summary'),
  message: { role: 'assistant', content: 'Test-only summary' },
};
const graph = (tools = ['read']) => {
  const d = createTemplate();
  d.nodes = [
    { ...d.nodes[0]!, model: 'unit-model', tools },
    { ...d.nodes[4]!, dependsOn: ['analyst'] },
  ];
  return d;
};
const until = async (fn: () => boolean) => {
  for (let i = 0; i < 500; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('state timeout');
};
const temp = () => {
  mkdirSync('.runtime', { recursive: true });
  return mkdtempSync(path.resolve('.runtime/tools-test-'));
};
const tool = (execute = vi.fn(async () => ({ value: 'real calculation' }))): ExecutableTool => ({
  name: 'read',
  description: 'test-only tool',
  parameters: { type: 'object' },
  scope: 'test',
  execute,
});
function setup(
  file: string,
  t: ExecutableTool,
  turn = vi.fn(async (_n: StudioNode, m: ModelMessage[]) =>
    m.some((x) => x.role === 'tool') ? final : call('read', { value: 1 }),
  ),
) {
  const journal = new ToolJournal(path.join(file, 'tools.sqlite'));
  const inference = { run: async () => result('unused'), turn };
  const runtime = new StudioRuntime(
    path.join(file, 'studio.sqlite'),
    new GovernedAgent(inference, journal, { catalog: () => [t] }),
  );
  return {
    journal,
    runtime,
    turn,
    close() {
      runtime.close();
      journal.close();
    },
  };
}
it('deterministic complete slice: model proposal -> policy -> persisted approval -> process reopen -> actual repository write -> audit -> replay', async () => {
  const directory = temp(),
    workspace = path.join(directory, 'workspace');
  mkdirSync(workspace);
  writeFileSync(path.join(workspace, 'notes.md'), 'Before');
  const broker = new RepositoryBroker(path.join(directory, 'recovery')),
    repository = await broker.grant(workspace),
    host = new DesktopTools(broker);
  host.repositoryId = repository.id;
  const before = await broker.read('notes.md');
  const request = call('repo_save', {
    path: 'notes.md',
    content: 'After',
    expectedHash: before.hash,
  });
  const turn = vi.fn(async (_n: StudioNode, m: ModelMessage[]) =>
    m.some((x) => x.role === 'tool') ? final : request,
  );
  const t = host.catalog().find((x) => x.name === 'repo_save')!;
  let s = setup(directory, t, turn);
  try {
    const run = s.runtime.start(
      graph(['repo_save']),
      'Test-only public instruction',
      false,
      'tool-integration',
    );
    await until(() => s.runtime.get(run.id).status === 'waiting');
    expect(readFileSync(path.join(workspace, 'notes.md'), 'utf8')).toBe('Before');
    const pending = s.journal.list(run.id)[0]!;
    expect(pending.state).toBe('pending');
    const events = s.runtime.get(run.id).events;
    s.close();
    s = setup(directory, t, turn);
    expect(s.runtime.get(run.id).events).toEqual(events);
    expect(s.journal.list(run.id)[0]).toEqual(pending);
    s.journal.decide(pending.id, true);
    s.runtime.continueTool(run.id, 'analyst', pending.id, true);
    await until(() => s.runtime.get(run.id).status === 'completed');
    expect(readFileSync(path.join(workspace, 'notes.md'), 'utf8')).toBe('After');
    expect(turn).toHaveBeenCalledTimes(2);
    expect(s.runtime.verify(run.id).valid).toBe(true);
    expect(s.runtime.artifact(run.id)).toContain('Test-only summary');
    expect(s.runtime.get(run.id).events.map((e) => e.type)).toEqual(
      expect.arrayContaining([
        'tool.approval_requested',
        'tool.approved',
        'tool.started',
        'tool.completed',
        'run.completed',
      ]),
    );
    s.close();
    s = setup(directory, t, turn);
    expect(s.runtime.get(run.id).status).toBe('completed');
    expect(turn).toHaveBeenCalledTimes(2);
  } finally {
    s.close();
  }
});
it('denial invokes neither tool nor a second model call', async () => {
  const t = tool(),
    s = setup(temp(), t);
  try {
    const r = s.runtime.start(graph(), 'Data', false, 'denial-test');
    await until(() => s.runtime.get(r.id).status === 'waiting');
    const a = s.journal.list(r.id)[0]!;
    s.journal.decide(a.id, false);
    s.runtime.continueTool(r.id, 'analyst', a.id, false);
    expect(s.runtime.get(r.id).status).toBe('cancelled');
    expect(t.execute).not.toHaveBeenCalled();
    expect(s.turn).toHaveBeenCalledTimes(1);
  } finally {
    s.close();
  }
});
it('unlisted tool is denied even when a model invents it', async () => {
  const t = tool(),
    s = setup(
      temp(),
      t,
      vi.fn(async () => call('delete_everything', {})),
    );
  try {
    const r = s.runtime.start(graph(), 'Data', false, 'unknown-tool');
    await until(() => s.runtime.get(r.id).status === 'failed');
    expect(t.execute).not.toHaveBeenCalled();
    expect(s.journal.list(r.id)).toHaveLength(0);
  } finally {
    s.close();
  }
});
it('approval cannot authorize changed arguments or manifest', () => {
  const j = new ToolJournal(':memory:');
  try {
    j.request('id', 'run', 'node', 'tool', { path: 'a' }, 'manifest');
    j.decide('id', true);
    expect(() => j.request('id', 'run', 'node', 'tool', { path: 'b' }, 'manifest')).toThrow(
      'thay đổi',
    );
    expect(() => j.request('id', 'run', 'node', 'tool', { path: 'a' }, 'new')).toThrow('thay đổi');
  } finally {
    j.close();
  }
});
it('an executing call becomes unknown after reopen and cannot be automatically retried', () => {
  const file = path.join(temp(), 'tools.sqlite');
  let j = new ToolJournal(file);
  j.request('id', 'run', 'node', 'tool', {}, 'manifest');
  j.decide('id', true);
  j.begin('id');
  j.close();
  j = new ToolJournal(file);
  try {
    expect(j.state('id')).toBe('unknown');
    expect(() => j.begin('id')).toThrow();
    expect(() => j.decide('id', true)).toThrow();
  } finally {
    j.close();
  }
});
it('persisted receipt is consumed after transcript checkpoint loss without duplicate effect', async () => {
  const j = new ToolJournal(':memory:'),
    t = tool(),
    turn = vi.fn(async (_n: StudioNode, m: ModelMessage[]) =>
      m.some((x) => x.role === 'tool') ? final : call('read', {}),
    );
  const agent = new GovernedAgent({ run: async () => result(''), turn }, j, { catalog: () => [t] }),
    node = graph().nodes[0]!,
    events = vi.fn(),
    ctx = { runId: 'run', nodeId: node.id, event: events };
  try {
    await expect(agent.run(node, 'data', new AbortController().signal, ctx)).rejects.toMatchObject({
      code: 'AWAITING_TOOL_APPROVAL',
    });
    const a = j.list('run')[0]!;
    j.decide(a.id, true);
    j.begin(a.id);
    j.finish(a.id, JSON.stringify({ receipt: 'already executed' }));
    const output = await agent.run(node, 'data', new AbortController().signal, ctx);
    expect(output.text).toBe(final.result.text);
    expect(t.execute).not.toHaveBeenCalled();
    expect(turn).toHaveBeenCalledTimes(2);
  } finally {
    j.close();
  }
});
it('enforces per-run tool quota and immutable manifest binding', () => {
  const j = new ToolJournal(':memory:');
  try {
    for (let i = 0; i < 24; i++) j.request(digest(i), 'run', 'node', 'tool', {}, 'manifest');
    expect(() => j.request('overflow', 'run', 'node', 'tool', {}, 'manifest')).toThrow('24');
  } finally {
    j.close();
  }
});

it('backs up both SQLite stores and restores pending approval with valid audit into new files', async () => {
  const folder = temp(),
    s = setup(folder, tool());
  let restored: ReturnType<typeof setup> | undefined;
  try {
    const run = s.runtime.start(graph(), 'Backup document', false, 'backup-operation');
    await until(() => s.runtime.get(run.id).status === 'waiting');
    const target = path.join(folder, 'backup');
    mkdirSync(target);
    s.runtime.backup(path.join(target, 'studio.sqlite'));
    s.journal.backup(path.join(target, 'tools.sqlite'));
    restored = setup(target, tool());
    expect(restored.runtime.get(run.id).events).toEqual(s.runtime.get(run.id).events);
    expect(restored.runtime.verify(run.id).valid).toBe(true);
    expect(restored.journal.list(run.id)).toEqual(s.journal.list(run.id));
    expect(() => s.runtime.backup(path.join(target, 'studio.sqlite'))).toThrow();
  } finally {
    restored?.close();
    s.close();
  }
});
