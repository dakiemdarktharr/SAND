import { Client, WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { metrics } from '@opentelemetry/api';
import { Store, type Principal, type OutboxItem } from '../../control-plane/src/store';
import { taskQueueFor } from './contracts';
import { WorkflowReconciler } from './reconciler';

const attempts = metrics.getMeter('sand.dispatcher').createCounter('sand.outbox.dispatch_attempts');
export class OutboxDispatcher {
  readonly owner = randomUUID();
  constructor(private readonly store: Store, private readonly client: Client, private readonly principal: Principal) {}
  async dispatchOne(item: OutboxItem): Promise<void> {
    const run = await this.store.getRun(this.principal, item.runId);
    if (!run) throw new Error('RUN_NOT_FOUND');
    if (item.action === 'start' && !['completed', 'failed', 'cancelled'].includes(run.status)) {
      try {
        await this.client.workflow.start('registryRefreshWorkflow', {
          workflowId: item.workflowId, taskQueue: taskQueueFor(this.principal), args: [{ ...this.principal, runId: item.runId }],
          workflowIdReusePolicy: 'REJECT_DUPLICATE', workflowIdConflictPolicy: 'FAIL',
          workflowExecutionTimeout: '10 minutes',
        });
      } catch (error) {
        if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
        const existing = await this.client.workflow.getHandle(item.workflowId).describe();
        if (existing.type !== 'registryRefreshWorkflow') throw new Error('WORKFLOW_IDENTITY_MISMATCH');
      }
    }
    if (item.action === 'cancel' && !['completed', 'failed', 'cancelled'].includes(run.status)) {
      await this.client.workflow.getHandle(item.workflowId).cancel();
    }
    await this.store.markOutboxDelivered(this.principal, item.id, this.owner);
  }
  async tick(): Promise<number> {
    const items = await this.store.claimOutbox(this.principal, this.owner, 10, 60);
    for (const item of items) {
      try {
        await this.dispatchOne(item);
        attempts.add(1, { action: item.action, result: 'delivered' });
      } catch {
        attempts.add(1, { action: item.action, result: 'retry' });
        // Never persist raw Temporal/gRPC errors (may contain endpoint credentials).
        await this.store.releaseOutbox(this.principal, item.id, this.owner, 'TEMPORAL_DISPATCH_UNAVAILABLE');
      }
    }
    return items.length;
  }
  async run(signal: AbortSignal): Promise<void> {
    const reconciler = new WorkflowReconciler(this.store, this.client, this.principal);
    let ticks = 0;
    while (!signal.aborted) {
      try { await this.tick(); if (++ticks % 10 === 0) await reconciler.tick(); } catch { /* DB outage: accepted outbox remains persistent. */ }
      try { await delay(500, undefined, { signal }); } catch { break; }
    }
  }
}
