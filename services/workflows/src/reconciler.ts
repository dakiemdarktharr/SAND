import { Client } from '@temporalio/client';
import { Store, type Principal } from '../../control-plane/src/store';

/** Repairs DB projections when a workflow cannot execute its final activity (timeout or operator termination). */
export class WorkflowReconciler {
  private cursor: string | undefined;
  constructor(private readonly store: Store, private readonly client: Client, private readonly principal: Principal) {}
  async tick(): Promise<number> {
    const runs = await this.store.unfinishedRuns(this.principal, this.cursor, 50);
    this.cursor = runs.length === 50 ? runs.at(-1)?.id : undefined;
    let repaired = 0;
    for (const run of runs) {
      try {
        const description = await this.client.workflow.getHandle('sand/' + this.principal.tenantId + '/' + run.id).describe();
        if (['RUNNING', 'CONTINUED_AS_NEW'].includes(description.status.name)) continue;
        // Registry workflows persist completion before returning; missing completion is a failed projection, never inferred success.
        const latest = await this.store.getRun(this.principal, run.id);
        if (!latest || ['completed', 'failed', 'cancelled'].includes(latest.status)) continue;
        if (latest.status === 'cancellation_requested') {
          await this.store.transitionRun(this.principal, run.id, 'cancelled', 'reconcile.cancelled');
        } else {
          await this.store.transitionRun(this.principal, run.id, 'failed', 'reconcile.terminal', { errorCode: 'TEMPORAL_' + description.status.name });
        }
        repaired++;
      } catch {
        // Not started or Temporal/DB unavailable: keep durable state intact and retry later.
      }
    }
    return repaired;
  }
}
