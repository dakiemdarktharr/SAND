export type Result<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };
export interface Repository { id: string; name: string; files: string[]; truncated: boolean }
export interface DocumentFile { repositoryId: string; path: string; content: string; hash: string }
export interface GitStatus { entries: { status: string; path: string }[]; branch: string }
export interface Run { id: string; projectId: string; kind: string; status: string; createdAt: string; updatedAt: string; errorCode?: string | null }
export interface RunEvent { id: string; runId: string; sequence: number; schemaVersion: number; type: string; at: string; payload: Record<string, unknown> }
export interface Bridge {
  repository: { open(): Promise<Result<Repository | null>>; list(): Promise<Result<Repository>>; read(path: string): Promise<Result<DocumentFile>>; save(input: { repositoryId: string; path: string; content: string; expectedHash: string; operationId: string }): Promise<Result<DocumentFile>>; status(): Promise<Result<GitStatus>>; diff(path: string): Promise<Result<string>> };
  control: { overview(): Promise<Result<Record<string, unknown>>>; projects(): Promise<Result<Record<string, unknown>[]>>; runs(): Promise<Result<Run[]>>; create(projectId: string, operationId: string): Promise<Result<Run>>; events(runId: string, after: number): Promise<Result<RunEvent[]>>; cancel(runId: string, operationId: string): Promise<Result<Run>>; models(): Promise<Result<Record<string, unknown>[]>>; verify(): Promise<Result<Record<string, unknown>>> };
}
declare global { interface Window { sand: Bridge } }

