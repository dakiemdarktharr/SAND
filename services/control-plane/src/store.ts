import { createHash, randomUUID } from 'node:crypto';
import { trace } from '@opentelemetry/api';
import type { Pool } from 'pg';
import { ToolPolicyEngine, type PolicySet } from '../../../packages/policy/src/index.js';
import { DomainError, type Database, type DatabaseClient, type OutboxItem, type Principal, type Run, type RunEvent, type RunStatus } from './types.js';
export type { Database, DatabaseClient, OutboxItem, Principal, Run, RunEvent, RunStatus } from './types.js';

const tracer = trace.getTracer('sand.control-plane.store', '0.1.0');
const terminal = new Set<RunStatus>(['completed', 'failed', 'cancelled']);
const transitions: Record<RunStatus, RunStatus[]> = {
  queued: ['running', 'failed', 'cancellation_requested'],
  running: ['completed', 'failed', 'cancellation_requested'],
  cancellation_requested: ['cancelled'], completed: [], failed: [], cancelled: [],
};
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}
export function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function iso(value: unknown): string { return value instanceof Date ? value.toISOString() : String(value); }
function toRun(r: Record<string, unknown>): Run {
  return { id: String(r.id), tenantId: String(r.tenant_id), projectId: String(r.project_id), kind: 'registry.refresh',
    status: r.status as RunStatus, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), errorCode: r.error_code ? String(r.error_code) : null, policyVersion: String(r.policy_version) };
}
function toEvent(r: Record<string, unknown>): RunEvent {
  return { id: String(r.id), runId: String(r.run_id), sequence: Number(r.sequence), schemaVersion: 1,
    type: String(r.type), at: iso(r.at), payload: r.payload as Record<string, unknown> };
}
export class PgDatabase implements Database {
  constructor(private readonly pool: Pool) {}
  async connect(): Promise<DatabaseClient> { return this.pool.connect(); }
}

/** Caller supplies trusted server identity. Never derive Principal from a request body. */
export class Store {
  constructor(private readonly db: Database, private readonly admissionPolicy?: PolicySet) {}
  async transaction<T>(principal: Principal, name: string, fn: (client: DatabaseClient) => Promise<T>): Promise<T> {
    return tracer.startActiveSpan(name, async span => {
      const client = await this.db.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('sand.tenant_id',$1,true), set_config('sand.actor_id',$2,true)", [principal.tenantId, principal.actorId]);
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        span.setAttribute('sand.error', error instanceof DomainError ? error.code : 'DATABASE_OPERATION_FAILED');
        throw error;
      } finally { client.release(); span.end(); }
    });
  }

  async assertRuntimeRole(): Promise<void> {
    const client = await this.db.connect();
    try {
      const { rows } = await client.query<{ rolsuper: boolean; rolbypassrls: boolean; owns_tables: boolean }>(
        `SELECT r.rolsuper,r.rolbypassrls,EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relowner=r.oid AND n.nspname='public' AND c.relname IN ('tenants','projects','runs','run_events','idempotency_records','outbox','registry_snapshots','audit_heads','audit_ledger')) AS owns_tables FROM pg_roles r WHERE r.rolname=current_user`);
      const role = rows[0];
      if (!role || role.rolsuper || role.rolbypassrls || role.owns_tables) throw new DomainError('UNSAFE_DATABASE_ROLE', 503, 'Use a non-owner runtime role without SUPERUSER or BYPASSRLS.');
    } finally { client.release(); }
  }
  async readiness(principal: Principal): Promise<boolean> {
    await this.assertRuntimeRole();
    return this.transaction(principal, 'db.readiness', async c => {
      const { rows } = await c.query('SELECT id FROM tenants WHERE id=$1', [principal.tenantId]);
      return rows.length === 1;
    });
  }
  async listProjects(p: Principal): Promise<{ id: string; name: string; createdAt: string }[]> {
    return this.transaction(p, 'projects.list', async c => (await c.query('SELECT id,name,created_at FROM projects ORDER BY created_at,id')).rows
      .map(r => ({ id: String(r.id), name: String(r.name), createdAt: iso(r.created_at) })));
  }
  async listRuns(p: Principal): Promise<Run[]> {
    return this.transaction(p, 'runs.list', async c => (await c.query('SELECT * FROM runs ORDER BY created_at DESC,id LIMIT 100')).rows.map(toRun));
  }
  async unfinishedRuns(p: Principal, afterId?: string, limit = 100): Promise<Run[]> {
    return this.transaction(p, 'runs.unfinished', async c => (await c.query("SELECT * FROM runs WHERE status IN ('queued','running','cancellation_requested') AND ($1::uuid IS NULL OR id>$1::uuid) ORDER BY id LIMIT $2", [afterId ?? null, Math.min(Math.max(limit, 1), 500)])).rows.map(toRun));
  }
  async getRun(p: Principal, runId: string): Promise<Run | null> {
    return this.transaction(p, 'runs.get', async c => {
      const r = (await c.query('SELECT * FROM runs WHERE id=$1', [runId])).rows[0];
      return r ? toRun(r) : null;
    });
  }
  private async lockRun(c: DatabaseClient, runId: string): Promise<Record<string, unknown>> {
    const row = (await c.query('SELECT * FROM runs WHERE id=$1 FOR UPDATE', [runId])).rows[0];
    if (!row) throw new DomainError('RUN_NOT_FOUND', 404, 'Run not found.');
    return row;
  }
  private async idempotent<T>(c: DatabaseClient, p: Principal, operation: string, key: string, input: unknown, execute: () => Promise<T>): Promise<{ value: T; replayed: boolean }> {
    if (!/^[\x21-\x7e]{8,128}$/.test(key)) throw new DomainError('INVALID_IDEMPOTENCY_KEY', 400, 'Idempotency-Key must contain 8–128 printable non-space characters.');
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${p.tenantId}/${p.actorId}/${operation}/${key}`]);
    const inputHash = digest(canonical(input));
    const prior = (await c.query('SELECT input_hash,response FROM idempotency_records WHERE tenant_id=$1 AND actor_id=$2 AND operation=$3 AND key=$4', [p.tenantId, p.actorId, operation, key])).rows[0];
    if (prior) {
      if (prior.input_hash !== inputHash) throw new DomainError('IDEMPOTENCY_CONFLICT', 409, 'This key was already used with different arguments. Use a new key for a new operation.');
      return { value: prior.response as T, replayed: true };
    }
    const value = await execute();
    await c.query('INSERT INTO idempotency_records(tenant_id,actor_id,operation,key,input_hash,response) VALUES($1,$2,$3,$4,$5,$6::jsonb)', [p.tenantId, p.actorId, operation, key, inputHash, canonical(value)]);
    return { value, replayed: false };
  }
  private async appendAudit(c: DatabaseClient, p: Principal, action: string, target: string, input: unknown, output: unknown): Promise<void> {
    await c.query('INSERT INTO audit_heads(tenant_id) VALUES($1) ON CONFLICT DO NOTHING', [p.tenantId]);
    const head = (await c.query('SELECT sequence,head_hash FROM audit_heads WHERE tenant_id=$1 FOR UPDATE', [p.tenantId])).rows[0]!;
    const body = canonical({ actor: p.actorId, organization: p.tenantId, action, target, inputHash: digest(canonical(input)), outputHash: digest(canonical(output)), policyVersion: this.admissionPolicy?.version ?? 'registry-v1', at: new Date().toISOString() });
    const previous = String(head.head_hash);
    await c.query('INSERT INTO audit_ledger(tenant_id,sequence,id,body,previous_hash,hash) VALUES($1,$2,$3,$4,$5,$6)', [p.tenantId, Number(head.sequence) + 1, randomUUID(), body, previous, digest(`${previous}\n${body}`)]);
  }
  private async appendEvent(c: DatabaseClient, p: Principal, runId: string, eventKey: string, type: string, payload: Record<string, unknown>): Promise<void> {
    const next = (await c.query('UPDATE runs SET next_sequence=next_sequence+1,updated_at=now() WHERE id=$1 RETURNING next_sequence', [runId])).rows[0]!;
    await c.query('INSERT INTO run_events(tenant_id,run_id,id,sequence,event_key,type,payload) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)', [p.tenantId, runId, randomUUID(), next.next_sequence, eventKey, type, canonical(payload)]);
    await this.appendAudit(c, p, type, runId, { eventKey }, payload);
  }
  private async enqueue(c: DatabaseClient, p: Principal, runId: string, action: 'start' | 'cancel'): Promise<void> {
    await c.query('INSERT INTO outbox(tenant_id,id,run_id,action,workflow_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,run_id,action) DO NOTHING', [p.tenantId, randomUUID(), runId, action, `sand/${p.tenantId}/${runId}`]);
  }
  async createRun(p: Principal, input: { projectId: string; kind: 'registry.refresh' }, key: string): Promise<{ run: Run; replayed: boolean }> {
    const policy: PolicySet = this.admissionPolicy ?? { tenantId: p.tenantId, organizationId: p.tenantId, version: 'registry-v1', rules: [{ id: 'local-registry-discovery', effect: 'allow', match: { tool: 'registry', operation: 'refresh', environment: 'development', dataSensitivity: 'public', networkDestination: null, arguments: [{ path: ['kind'], equals: 'registry.refresh' }] } }] };
    const decision = new ToolPolicyEngine().evaluate({ action: { actionId: digest(key), actorId: p.actorId, userId: p.actorId, tenantId: p.tenantId, organizationId: p.tenantId, projectId: input.projectId, sessionId: `local/${p.actorId}`, runId: null, tool: 'registry', operation: 'refresh', arguments: { projectId: input.projectId, kind: input.kind }, target: { kind: 'project', id: input.projectId, revision: null }, networkDestination: null, dataSensitivity: 'public', estimatedCost: null, environment: 'development', policyVersion: policy.version }, policy, now: Date.now() });
    if (decision.decision !== 'allow') {
      await this.transaction(p, 'policy.denied', async c => {
        await this.idempotent(c, p, 'policy.denied', key, input, async () => { await this.appendAudit(c, p, 'policy.denied', input.projectId, input, { decision: decision.decision, reason: decision.reason }); return { decision: decision.decision }; });
      });
      throw new DomainError(decision.decision === 'ask' ? 'APPROVAL_REQUIRED' : 'POLICY_DENIED', 403, decision.decision === 'ask' ? 'This action requires approval. Approval persistence is not available in this slice.' : 'The server policy denies this action.');
    }
    return this.transaction(p, 'runs.create', async c => {
      const result = await this.idempotent(c, p, 'runs.create', key, input, async () => {
        if (!(await c.query('SELECT id FROM projects WHERE id=$1', [input.projectId])).rows.length) throw new DomainError('PROJECT_NOT_FOUND', 404, 'Project not found.');
        const id = randomUUID();
        await c.query("INSERT INTO runs(tenant_id,id,project_id,actor_id,kind,status,policy_version) VALUES($1,$2,$3,$4,$5,'queued',$6)", [p.tenantId, id, input.projectId, p.actorId, input.kind, policy.version]);
        await this.appendEvent(c, p, id, 'accepted', 'run.accepted', { kind: input.kind, projectId: input.projectId, status: 'queued' });
        await this.enqueue(c, p, id, 'start');
        return toRun((await c.query('SELECT * FROM runs WHERE id=$1', [id])).rows[0]!);
      });
      return { run: result.value, replayed: result.replayed };
    });
  }
  async transitionRun(p: Principal, runId: string, status: RunStatus, eventKey: string, payload: Record<string, unknown> = {}): Promise<Run> {
    return this.transaction(p, 'runs.transition', async c => {
      const run = await this.lockRun(c, runId);
      const prior = (await c.query('SELECT payload FROM run_events WHERE run_id=$1 AND event_key=$2', [runId, eventKey])).rows[0];
      if (prior) {
        if ((prior.payload as Record<string, unknown>).status !== status) throw new DomainError('EVENT_KEY_CONFLICT', 409, 'The event key was already used for a different transition.');
        return toRun(run);
      }
      if (run.status === status) return toRun(run);
      if (!transitions[run.status as RunStatus].includes(status)) throw new DomainError('INVALID_RUN_TRANSITION', 409, `Cannot transition ${String(run.status)} to ${status}.`);
      const errorCode = typeof payload.errorCode === 'string' && /^[A-Z0-9_]{1,80}$/.test(payload.errorCode) ? payload.errorCode : null;
      await c.query('UPDATE runs SET status=$2,error_code=$3 WHERE id=$1', [runId, status, errorCode]);
      // Only safe metadata is persisted. Raw provider errors and input payloads never enter the timeline.
      await this.appendEvent(c, p, runId, eventKey, `run.${status}`, { status, ...(errorCode ? { errorCode } : {}) });
      return toRun((await c.query('SELECT * FROM runs WHERE id=$1', [runId])).rows[0]!);
    });
  }
  async requestCancellation(p: Principal, runId: string, key: string): Promise<Run> {
    return this.transaction(p, 'runs.cancel', async c => (await this.idempotent(c, p, `runs.cancel/${runId}`, key, { runId }, async () => {
      const run = await this.lockRun(c, runId);
      if (terminal.has(run.status as RunStatus) || run.status === 'cancellation_requested') return toRun(run);
      await c.query("UPDATE runs SET status='cancellation_requested' WHERE id=$1", [runId]);
      await this.appendEvent(c, p, runId, 'cancel-requested', 'run.cancellation_requested', { status: 'cancellation_requested' });
      await this.enqueue(c, p, runId, 'cancel');
      return toRun((await c.query('SELECT * FROM runs WHERE id=$1', [runId])).rows[0]!);
    })).value);
  }
  async events(p: Principal, runId: string, after = 0, limit = 100): Promise<{ events: RunEvent[]; lastSequence: number; hasMore: boolean }> {
    return this.transaction(p, 'events.replay', async c => {
      const run = (await c.query('SELECT next_sequence FROM runs WHERE id=$1', [runId])).rows[0];
      if (!run) throw new DomainError('RUN_NOT_FOUND', 404, 'Run not found.');
      const lastSequence = Number(run.next_sequence);
      if (after > lastSequence) throw new DomainError('CURSOR_AHEAD', 409, 'Cursor is ahead of this stream. Fetch a snapshot.');
      const rows = (await c.query('SELECT * FROM run_events WHERE run_id=$1 AND sequence>$2 AND sequence<=$4 ORDER BY sequence LIMIT $3', [runId, after, Math.min(Math.max(limit, 1), 500), lastSequence])).rows;
      const events = rows.map(toEvent);
      return { events, lastSequence, hasMore: (events.at(-1)?.sequence ?? after) < lastSequence };
    });
  }
  async snapshot(p: Principal, runId: string): Promise<{ run: Run; lastSequence: number; projection: { status: RunStatus } }> {
    return this.transaction(p, 'events.snapshot', async c => {
      const row = (await c.query('SELECT * FROM runs WHERE id=$1', [runId])).rows[0];
      if (!row) throw new DomainError('RUN_NOT_FOUND', 404, 'Run not found.');
      const run = toRun(row);
      return { run, lastSequence: Number(row.next_sequence), projection: { status: run.status } };
    });
  }
  async claimOutbox(p: Principal, owner: string, limit = 20, leaseSeconds = 30): Promise<OutboxItem[]> {
    return this.transaction(p, 'outbox.claim', async c => {
      const { rows } = await c.query(`WITH pending AS (SELECT tenant_id,id FROM outbox WHERE delivered_at IS NULL AND dead_letter_at IS NULL AND available_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY created_at,id LIMIT $1 FOR UPDATE SKIP LOCKED) UPDATE outbox o SET lease_owner=$2,lease_until=now()+($3 * interval '1 second'),attempts=o.attempts+1 FROM pending p WHERE o.tenant_id=p.tenant_id AND o.id=p.id RETURNING o.*`, [Math.min(limit, 100), owner, leaseSeconds]);
      return rows.map(r => ({ id: String(r.id), tenantId: String(r.tenant_id), runId: String(r.run_id), action: r.action as 'start' | 'cancel', workflowId: String(r.workflow_id), attempts: Number(r.attempts) }));
    });
  }
  async markOutboxDelivered(p: Principal, id: string, owner: string): Promise<void> {
    await this.transaction(p, 'outbox.delivered', async c => {
      await c.query('UPDATE outbox SET delivered_at=now(),lease_owner=NULL,lease_until=NULL WHERE id=$1 AND lease_owner=$2 AND lease_until>now()', [id, owner]);
    });
  }
  async releaseOutbox(p: Principal, id: string, owner: string, errorCode: string): Promise<void> {
    await this.transaction(p, 'outbox.release', async c => {
      const code = /^[A-Z0-9_]{1,80}$/.test(errorCode) ? errorCode : 'DISPATCH_FAILED';
      await c.query(`UPDATE outbox SET lease_owner=NULL,lease_until=NULL,last_error_code=$3,available_at=now()+(least(300,power(2,least(attempts,8)))*(0.75+random()*0.5)*interval '1 second'),dead_letter_at=CASE WHEN attempts>=20 THEN now() ELSE NULL END WHERE id=$1 AND lease_owner=$2`, [id, owner, code]);
    });
  }
  async saveRegistry(p: Principal, runId: string, eventKey: string, models: Record<string, unknown>[], outcomes: Record<string, unknown>[]): Promise<{ models: Record<string, unknown>[]; outcomes: Record<string, unknown>[] }> {
    return this.transaction(p, 'registry.save', async c => {
      const run = await this.lockRun(c, runId);
      if ((await c.query('SELECT id FROM run_events WHERE run_id=$1 AND event_key=$2', [runId, eventKey])).rows.length) {
        const snapshot = (await c.query('SELECT models,providers FROM registry_snapshots WHERE run_id=$1', [runId])).rows[0];
        if (!snapshot) throw new DomainError('REGISTRY_SNAPSHOT_MISSING', 503, 'The committed snapshot is unavailable. Operator recovery is required.');
        return { models: snapshot.models as Record<string, unknown>[], outcomes: snapshot.providers as Record<string, unknown>[] };
      }
      if (run.status !== 'running') throw new DomainError('RUN_NOT_RUNNING', 409, 'Registry results cannot be committed after cancellation or completion.');
      if ((await c.query('SELECT run_id FROM registry_snapshots WHERE run_id=$1', [runId])).rows.length) throw new DomainError('REGISTRY_SNAPSHOT_CONFLICT', 409, 'A snapshot was already committed under a different event key.');
      if (Buffer.byteLength(canonical(models)) > 8_000_000 || Buffer.byteLength(canonical(outcomes)) > 100_000) throw new DomainError('REGISTRY_TOO_LARGE', 413, 'Registry result exceeds the configured limit.');
      await c.query('INSERT INTO registry_snapshots(tenant_id,run_id,models,providers) VALUES($1,$2,$3::jsonb,$4::jsonb) ON CONFLICT(tenant_id,run_id) DO NOTHING', [p.tenantId, runId, canonical(models), canonical(outcomes)]);
      await this.appendEvent(c, p, runId, eventKey, 'registry.refreshed', { modelCount: models.length, providerCount: outcomes.length });
      return { models, outcomes };
    });
  }
  async listModels(p: Principal): Promise<{ models: Record<string, unknown>[]; providers: Record<string, unknown>[]; observedAt: string | null }> {
    return this.transaction(p, 'registry.list', async c => {
      const row = (await c.query('SELECT models,providers,observed_at FROM registry_snapshots ORDER BY observed_at DESC,run_id LIMIT 1')).rows[0];
      return row ? { models: row.models as Record<string, unknown>[], providers: row.providers as Record<string, unknown>[], observedAt: iso(row.observed_at) } : { models: [], providers: [], observedAt: null };
    });
  }
  async auditExport(p: Principal, after = 0, limit = 1000): Promise<{ entries: Record<string, unknown>[]; nextCursor: number | null }> {
    return this.transaction(p, 'audit.export', async c => {
      const bounded = Math.min(Math.max(limit, 1), 1000);
      const rows = (await c.query('SELECT sequence,id,body,previous_hash,hash,created_at FROM audit_ledger WHERE sequence>$1 ORDER BY sequence LIMIT $2', [after, bounded + 1])).rows;
      const entries = rows.slice(0, bounded).map(r => ({ sequence: Number(r.sequence), id: r.id, body: JSON.parse(String(r.body)) as unknown, previousHash: r.previous_hash, hash: r.hash, createdAt: iso(r.created_at) }));
      return { entries, nextCursor: rows.length > bounded ? Number(entries.at(-1)!.sequence) : null };
    });
  }
  async verifyAudit(p: Principal): Promise<{ valid: boolean; checked: number; headHash: string | null }> {
    return this.transaction(p, 'audit.verify', async c => {
      // Lock the head to take a consistent chain view while concurrent appends wait.
      const head = (await c.query('SELECT sequence,head_hash FROM audit_heads WHERE tenant_id=$1 FOR SHARE', [p.tenantId])).rows[0];
      const rows = (await c.query('SELECT sequence,body,previous_hash,hash FROM audit_ledger ORDER BY sequence')).rows;
      let hash = ''; let sequence = 0; let valid = true;
      for (const row of rows) {
        sequence++;
        if (Number(row.sequence) !== sequence || row.previous_hash !== hash || row.hash !== digest(`${hash}\n${String(row.body)}`)) valid = false;
        hash = String(row.hash);
      }
      if (Number(head?.sequence ?? 0) !== sequence || String(head?.head_hash ?? '') !== hash) valid = false;
      return { valid, checked: sequence, headHash: hash || null };
    });
  }
}
