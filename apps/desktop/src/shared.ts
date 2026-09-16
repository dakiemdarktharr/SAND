import type { Approval } from '../../../packages/tools/src/journal';
import type { Definition, StudioRun } from '../../../packages/studio/src/schema';
import type { DiscoveryResult } from '../../../packages/providers/src/types';
export type Result<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };
export interface Repository { id: string; name: string; files: string[]; truncated: boolean }
export interface DocumentFile { repositoryId: string; path: string; content: string; hash: string }
export interface GitStatus { entries: { status: string; path: string }[]; branch: string }
export interface Run { id: string; projectId: string; kind: string; status: string; createdAt: string; updatedAt: string; errorCode?: string | null }
export interface RunEvent { id: string; runId: string; sequence: number; schemaVersion: number; type: string; at: string; payload: Record<string, unknown> }
export interface Bridge {
  studio: {
    backup():Promise<Result<string|null>>;
    tools():Promise<Result<{name:string;description:string;scope:string}[]>>;
    approvals(runId:string):Promise<Result<Approval[]>>;
    approveTool(runId:string,id:string,approve:boolean):Promise<Result<StudioRun>>;
    security():Promise<Result<{vaultAvailable:boolean;providers:Record<string,boolean>;identity:{configured:boolean;signedIn:boolean;issuer?:string;subject?:string;expiresAt?:number}}>>;
    storeEnvironmentKey(name:string):Promise<Result<{stored:boolean}>>;
    removeStoredKey(name:string):Promise<Result<{removed:boolean;environmentStillConfigured:boolean}>>;
    login():Promise<Result<{signedIn:boolean}>>;logout():Promise<Result<{signedIn:boolean;revoked:boolean}>>;
    connectMcp():Promise<Result<{id:string;manifestHash:string;tools:{name:string;description:string}[]}|null>>;
    disconnectMcp(id:string):Promise<Result<{disconnected:boolean}>>;
    definitions():Promise<Result<Definition[]>>; save(definition:Definition):Promise<Result<Definition>>;
    discover():Promise<Result<DiscoveryResult & {inferenceProviders:string[]}>>;
    runs():Promise<Result<{id:string;name:string;status:string;createdAt:string}[]>>; get(id:string):Promise<Result<StudioRun>>;
    start(input:{definition:Definition;input:string;allowCloud:boolean;key:string}):Promise<Result<StudioRun>>;
    command(id:string,action:'pause'|'resume'|'cancel'):Promise<Result<StudioRun>>;
    review(id:string,nodeId:string,approve:boolean):Promise<Result<StudioRun>>;
    verify(id:string):Promise<Result<{valid:boolean;checked:number}>>;
    export(id:string):Promise<Result<string|null>>;
    importText():Promise<Result<{name:string;text:string}|null>>;
  };
  repository: { open(): Promise<Result<Repository | null>>; list(): Promise<Result<Repository>>; read(path: string): Promise<Result<DocumentFile>>; save(input: { repositoryId: string; path: string; content: string; expectedHash: string; operationId: string }): Promise<Result<DocumentFile>>; status(): Promise<Result<GitStatus>>; diff(path: string): Promise<Result<string>> };
  control: { overview(): Promise<Result<Record<string, unknown>>>; projects(): Promise<Result<Record<string, unknown>[]>>; runs(): Promise<Result<Run[]>>; create(projectId: string, operationId: string): Promise<Result<Run>>; events(runId: string, after: number): Promise<Result<RunEvent[]>>; cancel(runId: string, operationId: string): Promise<Result<Run>>; models(): Promise<Result<Record<string, unknown>[]>>; verify(): Promise<Result<Record<string, unknown>>> };
}
declare global { interface Window { sand: Bridge } }

