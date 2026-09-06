import { proxyActivities, CancellationScope, isCancellation, ApplicationFailure, ActivityCancellationType } from '@temporalio/workflow';
import type { RegistryActivities, RunInput } from './contracts';

const activities = proxyActivities<RegistryActivities>({
  startToCloseTimeout: '2 minutes',
  scheduleToCloseTimeout: '5 minutes',
  heartbeatTimeout: '5 seconds',
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: { initialInterval: '1 second', backoffCoefficient: 2, maximumInterval: '20 seconds', maximumAttempts: 4, nonRetryableErrorTypes: ['FORBIDDEN_WORKER_IDENTITY', 'RUN_NOT_FOUND', 'INVALID_TRANSITION'] },
});
/** Deterministic orchestration only. Provider credentials and models never enter workflow history. */
export async function registryRefreshWorkflow(input: RunInput): Promise<void> {
  try {
    if (await activities.beginRun(input) === 'cancellation_requested') {
      await activities.finishRun(input, 'cancelled');
      return;
    }
    const outcome = await activities.refreshRegistry(input);
    if (outcome.available === 0) {
      await activities.finishRun(input, 'failed', 'NO_PROVIDER_AVAILABLE');
      throw ApplicationFailure.nonRetryable('No configured provider could be discovered.', 'NO_PROVIDER_AVAILABLE');
    }
    await activities.finishRun(input, 'completed');
  } catch (error) {
    if (isCancellation(error)) {
      await CancellationScope.nonCancellable(() => activities.finishRun(input, 'cancelled'));
      throw error;
    }
    await CancellationScope.nonCancellable(() => activities.finishRun(input, 'failed', 'WORKFLOW_FAILED'));
    throw error;
  }
}
