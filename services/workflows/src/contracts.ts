export interface RunInput { tenantId: string; actorId: string; runId: string }
export interface RegistryActivities {
  beginRun(input: RunInput): Promise<'running' | 'cancellation_requested'>;
  refreshRegistry(input: RunInput): Promise<{ available: number; failed: number; unconfigured: number }>;
  finishRun(input: RunInput, state: 'completed' | 'failed' | 'cancelled', errorCode?: string): Promise<void>;
}
export const taskQueue = 'sand-registry-v1';

export function taskQueueFor(principal: {tenantId:string;actorId:string}): string {
  return taskQueue + '/' + principal.tenantId + '/' + principal.actorId;
}
