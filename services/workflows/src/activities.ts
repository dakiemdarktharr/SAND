import { heartbeat, cancellationSignal } from '@temporalio/activity';
import { ApplicationFailure, CancelledFailure } from '@temporalio/common';
import { Store, type Principal } from '../../control-plane/src/store';
import { DomainError } from '../../control-plane/src/types';
import { ModelRegistry } from '../../../packages/providers/src/registry';
import type { RegistryActivities, RunInput } from './contracts';

export function createActivities(store: Store, registry: ModelRegistry, principal: Principal): RegistryActivities {
  function validate(input: RunInput): void {
    if (input.tenantId !== principal.tenantId || input.actorId !== principal.actorId) {
      throw ApplicationFailure.nonRetryable('Worker identity does not match run owner.', 'FORBIDDEN_WORKER_IDENTITY');
    }
  }
  async function inActivity<T>(input: RunInput, work: () => Promise<T>): Promise<T> {
    validate(input);
    heartbeat({ runId: input.runId });
    const timer = setInterval(() => heartbeat({ runId: input.runId }), 1000);
    try { return await work(); }
    catch (error) {
      if (cancellationSignal().aborted) throw new CancelledFailure('Activity cancelled.');
      if (error instanceof DomainError) throw ApplicationFailure.nonRetryable(error.code, error.code);
      throw error;
    } finally { clearInterval(timer); }
  }
  return {
    beginRun: input => inActivity(input, async () => {
      const run = await store.getRun(principal, input.runId);
      if (!run) throw new DomainError('RUN_NOT_FOUND', 404, 'Run not found.');
      if (run.status === 'cancellation_requested') return 'cancellation_requested';
      await store.transitionRun(principal, input.runId, 'running', 'workflow.begin');
      return 'running';
    }),
    refreshRegistry: input => inActivity(input, async () => {
      const result = await registry.refresh(cancellationSignal());
      const committed = await store.saveRegistry(principal, input.runId, 'registry.snapshot',
        result.models.map(model => ({ ...model })), result.outcomes.map(outcome => ({ ...outcome })));
      return {
        available: committed.outcomes.filter(outcome => outcome.status === 'available').length,
        failed: committed.outcomes.filter(outcome => outcome.status === 'error').length,
        unconfigured: committed.outcomes.filter(outcome => outcome.status === 'unconfigured').length,
      };
    }),
    finishRun: (input, state, errorCode) => inActivity(input, async () => {
      const run = await store.getRun(principal, input.runId);
      if (!run || ['completed', 'failed', 'cancelled'].includes(run.status)) return;
      if (run.status === 'cancellation_requested') {
        await store.transitionRun(principal, input.runId, 'cancelled', 'workflow.cancelled');
      } else if (state === 'cancelled') {
        // Temporal cancellation without API intent still must persist intent before terminal acknowledgement.
        await store.transitionRun(principal, input.runId, 'cancellation_requested', 'workflow.cancel-request');
        await store.transitionRun(principal, input.runId, 'cancelled', 'workflow.cancelled');
      } else {
        await store.transitionRun(principal, input.runId, state, 'workflow.' + state, errorCode ? { errorCode } : {});
      }
    }),
  };
}
