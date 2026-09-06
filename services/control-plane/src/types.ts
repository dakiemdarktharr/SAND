export interface Principal { tenantId: string; actorId: string }
export type RunStatus = 'queued' | 'running' | 'cancellation_requested' | 'completed' | 'failed' | 'cancelled';
export interface Run {
  id: string; tenantId: string; projectId: string; kind: 'registry.refresh'; status: RunStatus;
  createdAt: string; updatedAt: string; errorCode: string | null; policyVersion: string;
}
export interface RunEvent {
  id: string; runId: string; sequence: number; schemaVersion: 1; type: string;
  at: string; payload: Record<string, unknown>;
}
export interface OutboxItem {
  id: string; tenantId: string; runId: string; action: 'start' | 'cancel'; workflowId: string; attempts: number;
}
export interface DatabaseClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
  release(): void;
}
export interface Database { connect(): Promise<DatabaseClient> }
export class DomainError extends Error {
  constructor(public readonly code: string, public readonly statusCode: number, message: string) { super(message); }
}
