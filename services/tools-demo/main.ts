import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { TextInference } from '../../packages/studio/src/inference.js';
import { StudioRuntime } from '../../packages/studio/src/runtime.js';
import { createTemplate } from '../../packages/studio/src/schema.js';
import { ToolJournal } from '../../packages/tools/src/journal.js';
import { GovernedAgent } from '../../packages/tools/src/agent.js';
import { RepositoryBroker } from '../../apps/desktop/src/repository.js';
import { DesktopTools } from '../../apps/desktop/src/tools.js';
const started = performance.now();
await mkdir('.runtime', { recursive: true });
const directory = await mkdtemp(path.resolve('.runtime/governed-demo-')),
  workspace = path.join(directory, 'workspace');
await mkdir(workspace);
await writeFile(
  path.join(workspace, 'brief.md'),
  'Museum brief: Volunteers summarize exhibit notes. A curator must approve publication. Budget and deadline are unspecified.',
);
const repository = new RepositoryBroker(path.join(directory, 'recovery')),
  grant = await repository.grant(workspace),
  tools = new DesktopTools(repository);
tools.repositoryId = grant.id;
const inference = new TextInference({ SAND_OLLAMA_ORIGIN: process.env.SAND_OLLAMA_ORIGIN }),
  discovery = await inference.discover();
const model =
  process.env.SAND_TOOL_MODEL ??
  discovery.models.find((m) => m.provider === 'ollama' && m.modelId.includes('qwen'))?.modelId;
assert(
  model && discovery.models.some((m) => m.provider === 'ollama' && m.modelId === model),
  'Set SAND_TOOL_MODEL to an installed tool-capable Ollama model. No downloads or cloud fallback.',
);
let approvedTool = 'repo_read',
  approvedArguments: Record<string, unknown> = { path: 'brief.md' },
  instruction =
    'First call repo_read exactly once with path brief.md. Read its actual result and then summarize the requirement and missing information in two English sentences. Do not call any other tool.';
if (process.argv.includes('--research')) {
  approvedTool = 'web_read';
  approvedArguments = { url: 'https://example.com/' };
  instruction =
    'Call web_read exactly once with url https://example.com/ . After receiving the actual page, explain what this domain is for and cite its source URL. Use no other tool.';
}
if (process.argv.includes('--mcp')) {
  await tools.mcp.connect({
    id: 'utility',
    transport: 'stdio',
    command: process.execPath,
    args: ['--import', 'tsx', 'services/mcp-utility/main.ts'],
  });
  approvedTool = tools.mcp.catalog()[0]!.name;
  approvedArguments = { text: 'Museums need human review' };
  instruction =
    'Call ' +
    approvedTool +
    ' exactly once with arguments ' +
    JSON.stringify(approvedArguments) +
    '. Preserve the exact text value, including punctuation. Then report the actual word count from the tool. Do not invent counts.';
}
if (process.argv.includes('--edit')) {
  const source = await repository.read('brief.md');
  approvedTool = 'repo_save';
  approvedArguments = {
    path: 'brief.md',
    content:
      'Museum workflow: volunteers draft exhibit summaries; a curator approves before publication. Open questions: budget and deadline.',
    expectedHash: source.hash,
  };
  instruction =
    'Call repo_save exactly once with these exact arguments: ' +
    JSON.stringify(approvedArguments) +
    '. Then report whether the tool returned a saved file hash. Do not invent success.';
}
const graph = createTemplate();
graph.name = 'Governed repository research';
graph.concurrency = 1;
graph.nodes = [
  {
    ...graph.nodes[0]!,
    model,
    toolProtocol: 'json',
    tools: [approvedTool],
    maxOutputTokens: 512,
    instructions: instruction,
  },
  { ...graph.nodes[3]!, dependsOn: ['analyst'] },
  { ...graph.nodes[4]! },
];
const database = path.join(directory, 'studio.sqlite'),
  journalFile = path.join(directory, 'tools.sqlite');
let journal = new ToolJournal(journalFile),
  runtime = new StudioRuntime(database, new GovernedAgent(inference, journal, tools));
const wait = async (id: string, status: string) => {
  const deadline = Date.now() + 240000;
  while (runtime.get(id).status !== status) {
    const r = runtime.get(id);
    assert(!['failed', 'cancelled'].includes(r.status), JSON.stringify(r.events.at(-1)));
    assert(Date.now() < deadline, 'Demo timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
};
try {
  const run = runtime.start(runtime.save(graph), instruction, false, crypto.randomUUID());
  await wait(run.id, 'waiting');
  const request = journal.list(run.id).find((a) => a.state === 'pending');
  assert(request, 'Model must actually request a tool; text-only output does not pass this demo.');
  assert.equal(request.tool, approvedTool);
  assert.deepEqual(request.arguments, approvedArguments);
  console.log(
    JSON.stringify({
      event: 'demo.approval_required',
      at: new Date().toISOString(),
      tool: request.tool,
      arguments: request.arguments,
      argumentHash: request.argumentHash,
      executed: false,
    }),
  );
  const events = runtime.get(run.id).events;
  runtime.close();
  journal.close();
  journal = new ToolJournal(journalFile);
  runtime = new StudioRuntime(database, new GovernedAgent(inference, journal, tools));
  assert.deepEqual(runtime.get(run.id).events, events);
  console.log(
    JSON.stringify({
      event: 'demo.restored',
      preservedEvents: events.length,
      providerCallsReplayed: 0,
    }),
  );
  // This documented demo approves ONLY its generated non-sensitive brief.md read.
  journal.decide(request.id, true);
  runtime.continueTool(run.id, request.nodeId, request.id, true);
  await wait(run.id, 'waiting');
  assert(
    runtime.get(run.id).nodes.find((n) => n.id === 'review')?.state === 'waiting',
    'Unexpected additional tool request: demo will not auto-approve it.',
  );
  runtime.review(run.id, 'review', true);
  const completed = runtime.get(run.id);
  assert.equal(completed.status, 'completed');
  assert(runtime.verify(run.id).valid);
  assert.equal(journal.list(run.id).filter((a) => a.state === 'completed').length, 1);
  assert.equal(
    await readFile(path.join(workspace, 'brief.md'), 'utf8'),
    process.argv.includes('--edit')
      ? approvedArguments.content
      : 'Museum brief: Volunteers summarize exhibit notes. A curator must approve publication. Budget and deadline are unspecified.',
  );
  const summary = {
    event: 'demo.completed',
    observedAt: new Date().toISOString(),
    status: completed.status,
    model,
    realModelTurns: completed.events.filter((e) => e.type === 'model.turn_completed').length,
    toolCalls: 1,
    tool: approvedTool,
    preservedEvents: events.length,
    audit: runtime.verify(run.id),
    elapsedMs: Math.round(performance.now() - started),
    usage: completed.nodes[0]!.result,
    directory,
    claims:
      'One actual local run; generated public demo brief; scripted approval restricted to one exact configured call; not a production or quality benchmark',
  };
  await writeFile(path.join(directory, 'report.md'), runtime.artifact(run.id));
  await writeFile(
    path.join(directory, 'audit.jsonl'),
    completed.events.map((e) => JSON.stringify(e)).join('\n') + '\n',
  );
  await writeFile(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
} finally {
  runtime.close();
  journal.close();
  await tools.mcp.close();
}
