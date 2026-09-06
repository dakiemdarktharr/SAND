import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { nativePostgres } from '../helpers/native-postgres';
import { createActivities } from '../../services/workflows/src/activities';
import { OutboxDispatcher } from '../../services/workflows/src/dispatcher';
import { ModelRegistry } from '../../packages/providers/src/registry';
import { WorkflowReconciler } from '../../services/workflows/src/reconciler';
import { taskQueueFor } from '../../services/workflows/src/contracts';

const enabled = process.env.SAND_TEMPORAL_TESTS === '1';
describe.skipIf(!enabled)('REAL PostgreSQL + REAL Temporal workflow integration (set SAND_TEMPORAL_TESTS=1)', () => {
  let db: Awaited<ReturnType<typeof nativePostgres>>;
  let temporal: TestWorkflowEnvironment;
  beforeAll(async () => {
    db = await nativePostgres();
    temporal = await TestWorkflowEnvironment.createLocal({ server: { ip: '127.0.0.1', ui: false } });
  }, 120_000);
  afterAll(async () => { await temporal?.teardown(); await db?.close(); });
  async function worker(registry: ModelRegistry) {
    return Worker.create({
      connection: temporal.nativeConnection, taskQueue: taskQueueFor(db.principal),
      workflowsPath: fileURLToPath(new URL('../../services/workflows/src/workflow.ts', import.meta.url)),
      activities: createActivities(db.store, registry, db.principal),
      maxConcurrentActivityTaskExecutions: 2, maxHeartbeatThrottleInterval: '1 second',
    });
  }
  it('keeps a committed accepted run until a worker starts; absent providers fail honestly with persisted outcomes', async () => {
    const created = await db.store.createRun(db.principal, { projectId: db.projectId, kind: 'registry.refresh' }, randomUUID());
    const dispatcher = new OutboxDispatcher(db.store, temporal.client, db.principal);
    await dispatcher.tick();
    expect((await db.store.getRun(db.principal, created.run.id))?.status).toBe('queued');
    const runner = await worker(new ModelRegistry({}));
    const handle = temporal.client.workflow.getHandle('sand/' + db.principal.tenantId + '/' + created.run.id);
    await runner.runUntil(async () => {
      await expect(handle.result()).rejects.toThrow();
    });
    expect((await db.store.getRun(db.principal, created.run.id))?.status).toBe('failed');
    const registry = await db.store.listModels(db.principal);
    expect(registry.models).toEqual([]);
    expect(registry.providers).toHaveLength(5);
    expect(registry.providers.every(provider => provider.status === 'unconfigured')).toBe(true);
  }, 90_000);
  it('recovers start-before-ack by reconciling the same workflow ID and then cancels queued work', async () => {
    const created = await db.store.createRun(db.principal, { projectId: db.projectId, kind: 'registry.refresh' }, randomUUID());
    const dispatcher = new OutboxDispatcher(db.store, temporal.client, db.principal);
    const [item] = await db.store.claimOutbox(db.principal, dispatcher.owner, 10, 60);
    expect(item).toBeDefined();
    await temporal.client.workflow.start('registryRefreshWorkflow', { taskQueue: taskQueueFor(db.principal), workflowId: item!.workflowId, args: [{ ...db.principal, runId: created.run.id }], workflowIdReusePolicy: 'REJECT_DUPLICATE' });
    // The dispatcher crashed here: no DB delivery acknowledgement. Release its lease to emulate expiry.
    await db.store.releaseOutbox(db.principal, item!.id, dispatcher.owner, 'TEST_LOST_ACK');
    await db.store.requestCancellation(db.principal, created.run.id, randomUUID());
    const runner = await worker(new ModelRegistry({}));
    const handle = temporal.client.workflow.getHandle(item!.workflowId);
    await runner.runUntil(async () => {
      await dispatcher.tick();
      try { await handle.result(); } catch { /* cancellation is an expected Temporal terminal state */ }
    });
    expect((await db.store.getRun(db.principal, created.run.id))?.status).toBe('cancelled');
    const history = await handle.fetchHistory();
    const starts = history.events?.filter(event => event.workflowExecutionStartedEventAttributes);
    expect(starts).toHaveLength(1);
  }, 90_000);
  it('repairs externally terminated workflows that cannot execute a final activity', async () => {
    const created = await db.store.createRun(db.principal, { projectId: db.projectId, kind: 'registry.refresh' }, randomUUID());
    await new OutboxDispatcher(db.store, temporal.client, db.principal).tick();
    await temporal.client.workflow.getHandle('sand/' + db.principal.tenantId + '/' + created.run.id).terminate('Controlled integration fault');
    expect(await new WorkflowReconciler(db.store, temporal.client, db.principal).tick()).toBeGreaterThanOrEqual(1);
    expect(await db.store.getRun(db.principal, created.run.id)).toMatchObject({ status: 'failed', errorCode: 'TEMPORAL_TERMINATED' });
  }, 30_000);
  it('serializes concurrent admission in real PostgreSQL with one persisted logical effect', async () => {
    const key = randomUUID();
    const requests = await Promise.all(Array.from({length: 12}, () => db.store.createRun(db.principal, {projectId: db.projectId, kind: 'registry.refresh'}, key)));
    expect(new Set(requests.map(request => request.run.id)).size).toBe(1);
    const events = await db.store.events(db.principal, requests[0]!.run.id);
    expect(events.events).toHaveLength(1);
    expect((await db.store.verifyAudit(db.principal)).valid).toBe(true);
    await db.store.requestCancellation(db.principal, requests[0]!.run.id, randomUUID());
  }, 30_000);
  it.skipIf(process.env.SAND_OPENROUTER_PUBLIC_DISCOVERY !== '1')('runs a real public OpenRouter discovery through PostgreSQL/outbox/Temporal and verifies audit', async () => {
    const created = await db.store.createRun(db.principal, { projectId: db.projectId, kind: 'registry.refresh' }, randomUUID());
    const runner = await worker(new ModelRegistry({ openrouterPublicDiscovery: true }));
    const dispatcher = new OutboxDispatcher(db.store, temporal.client, db.principal);
    await runner.runUntil(async () => {
      await dispatcher.tick();
      await temporal.client.workflow.getHandle('sand/' + db.principal.tenantId + '/' + created.run.id).result();
    });
    expect((await db.store.getRun(db.principal, created.run.id))?.status).toBe('completed');
    const registry = await db.store.listModels(db.principal);
    expect(registry.models.length).toBeGreaterThan(0);
    expect(registry.models.every(model => model.source && model.observedAt)).toBe(true);
    expect(registry.providers.find(provider => provider.provider === 'openrouter')?.status).toBe('available');
    expect((await db.store.verifyAudit(db.principal)).valid).toBe(true);
  }, 90_000);
});
