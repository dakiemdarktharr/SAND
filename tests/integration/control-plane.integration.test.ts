import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { Pool } from 'pg';
import type { PolicySet } from '../../packages/policy/src/index.js';
import { Store, PgDatabase } from '../../services/control-plane/src/store.js';
import { buildServer } from '../../services/control-plane/src/server.js';
import { readLocalConfiguration } from '../../services/control-plane/src/main.js';
import { bootstrapDevelopment, migrate } from '../../services/control-plane/src/migrations.js';
import { createTestDb } from './control-plane-db.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup() { const db = await createTestDb(); cleanup.push(db.close); return db; }
const token = 'test-only-token-0123456789-abcdef-0123456789';
async function server(options: Parameters<typeof buildServer>[0]['stream'] = {}) {
  const data = await setup();
  const app = await buildServer({ store: data.store, principal: data.principal, token, stream: options });
  cleanup.push(() => app.close());
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  return { ...data, app, address: address.replace('http:', 'ws:'), auth: { authorization: `Bearer ${token}` } };
}
async function connect(url: string, authorization = `Bearer ${token}`) {
  const socket = new WebSocket(url, { headers: { authorization } });
  const messages: Record<string, unknown>[] = [];
  socket.on('message', bytes => { messages.push(JSON.parse(bytes.toString()) as Record<string, unknown>); });
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  cleanup.push(async () => { socket.terminate(); });
  return { socket, messages };
}
async function until(predicate: () => boolean, timeoutMs = 3000) {
  const started = Date.now();
  while (!predicate()) { if (Date.now() - started > timeoutMs) throw new Error('Condition timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
function eventSequences(messages: Record<string, unknown>[]): number[] {
  return messages.flatMap(m => m.type === 'batch' ? (m.events as { sequence: number }[]).map(e => e.sequence) : []);
}

describe('PostgreSQL migrations and tenant boundary (actual PGlite PostgreSQL engine)', () => {
  it('applies migrations exactly once with checksums and enforces a non-owner runtime role', async () => {
    const d = await setup();
    await expect(d.store.assertRuntimeRole()).resolves.toBeUndefined();
    await d.asAdmin(async c => {
      expect(await migrate(c)).toEqual([]);
      await c.query("UPDATE schema_migrations SET checksum='corrupt' WHERE version='001_foundation.sql'");
      await expect(migrate(c)).rejects.toThrow('checksum mismatch');
      await expect(new Store({ connect: async () => c }).assertRuntimeRole()).rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' });
    });
  });
  it('rejects a runtime role that owns an outbox table even without SUPERUSER/BYPASSRLS', async () => {
    const d = await setup();
    await d.asAdmin(c => c.query('ALTER TABLE outbox OWNER TO sand_test_runtime'));
    await expect(d.store.assertRuntimeRole()).rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' });
  });
  it('returns the original committed registry snapshot when an activity retries with changed discovery output', async () => {
    const d = await setup();
    const { run } = await d.store.createRun(d.principal, { projectId: d.projectId, kind: 'registry.refresh' }, 'registry-retry-key');
    await d.store.transitionRun(d.principal, run.id, 'running', 'workflow.begin');
    // Explicit unit/integration fixture records; no network provider is claimed by this persistence test.
    const original = { models: [{ provider: 'test-only-fixture', modelId: 'fixture-v1' }], outcomes: [{ provider: 'test-only-fixture', status: 'available' }] };
    expect(await d.store.saveRegistry(d.principal, run.id, 'registry.snapshot', original.models, original.outcomes)).toEqual(original);
    expect(await d.store.saveRegistry(d.principal, run.id, 'registry.snapshot', [], [])).toEqual(original);
    expect((await d.store.events(d.principal, run.id)).events).toHaveLength(3);
    const auditPage = await d.store.auditExport(d.principal, 0, 2);
    expect(auditPage.entries).toHaveLength(2);
    expect(auditPage.nextCursor).toBe(2);
    const auditTail = await d.store.auditExport(d.principal, auditPage.nextCursor!, 2);
    expect(auditTail.entries).toHaveLength(1);
    expect(auditTail.nextCursor).toBeNull();
    const page = await d.store.events(d.principal, run.id, 0, 2);
    expect(page.events.every(event => event.sequence <= page.lastSequence)).toBe(true);
    expect(page.hasMore).toBe(true);
    const other = { tenantId: randomUUID(), actorId: randomUUID() };
    await d.asAdmin(c => bootstrapDevelopment(c, other.tenantId, randomUUID()));
    expect(await d.store.listModels(other)).toEqual({ models: [], providers: [], observedAt: null });
    expect((await d.store.unfinishedRuns(d.principal)).map(item => item.id)).toEqual([run.id]);
    expect(await d.store.unfinishedRuns(d.principal, run.id)).toEqual([]);
  });
  it('commits run, event, audit and outbox atomically and replays the stored response', async () => {
    const d = await setup();
    const input = { projectId: d.projectId, kind: 'registry.refresh' as const };
    const [first, second] = await Promise.all([d.store.createRun(d.principal, input, 'same-operation-key'), d.store.createRun(d.principal, input, 'same-operation-key')]);
    expect(first.run.id).toBe(second.run.id);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    expect((await d.store.events(d.principal, first.run.id)).events).toHaveLength(1);
    expect(await d.store.verifyAudit(d.principal)).toMatchObject({ valid: true, checked: 1 });
    expect(await d.store.claimOutbox(d.principal, 'dispatcher-a')).toHaveLength(1);
    expect(await d.store.claimOutbox(d.principal, 'dispatcher-b')).toHaveLength(0);
    await expect(d.store.createRun(d.principal, { ...input, projectId: randomUUID() }, 'same-operation-key')).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(await d.store.listRuns(d.principal)).toHaveLength(1);
  });
  it('rolls back all admission records when audit insertion fails', async () => {
    const d = await setup();
    await d.asAdmin(c => c.query('REVOKE INSERT ON audit_ledger FROM sand_test_runtime'));
    await expect(d.store.createRun(d.principal, { projectId: d.projectId, kind: 'registry.refresh' }, 'rollback-operation')).rejects.toBeTruthy();
    expect(await d.store.listRuns(d.principal)).toHaveLength(0);
    expect(await d.store.claimOutbox(d.principal, 'dispatcher')).toHaveLength(0);
    expect(await d.store.verifyAudit(d.principal)).toMatchObject({ valid: true, checked: 0 });
    await d.asAdmin(async c => { for (const table of ['runs', 'run_events', 'outbox', 'idempotency_records']) expect((await c.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]?.n).toBe(0); });
  });
  it('isolates projects/runs/events/snapshots/outbox/audit and rejects composite foreign-key tenant mismatch', async () => {
    const d = await setup();
    const other = { tenantId: randomUUID(), actorId: randomUUID() }; const project = randomUUID();
    await d.asAdmin(c => bootstrapDevelopment(c, other.tenantId, project));
    const created = await d.store.createRun(d.principal, { projectId: d.projectId, kind: 'registry.refresh' }, 'tenant-one-create');
    expect(await d.store.getRun(other, created.run.id)).toBeNull();
    expect(await d.store.listRuns(other)).toEqual([]);
    await expect(d.store.events(other, created.run.id)).rejects.toMatchObject({ code: 'RUN_NOT_FOUND' });
    await expect(d.store.snapshot(other, created.run.id)).rejects.toMatchObject({ code: 'RUN_NOT_FOUND' });
    await expect(d.store.requestCancellation(other, created.run.id, 'other-tenant-cancel')).rejects.toMatchObject({ code: 'RUN_NOT_FOUND' });
    expect(await d.store.claimOutbox(other, 'other')).toEqual([]);
    expect(await d.store.auditExport(other)).toEqual({ entries: [], nextCursor: null });
    await expect(d.store.createRun(other, { projectId: d.projectId, kind: 'registry.refresh' }, 'foreign-project-key')).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    await expect(d.store.transaction(other, 'test.foreign-key', c => c.query("INSERT INTO runs(tenant_id,id,project_id,actor_id,kind,status) VALUES($1,$2,$3,$4,'registry.refresh','queued')", [other.tenantId, randomUUID(), d.projectId, other.actorId]))).rejects.toBeTruthy();
    await expect(d.store.transaction(other, 'test.rls-write', c => c.query("INSERT INTO runs(tenant_id,id,project_id,actor_id,kind,status) VALUES($1,$2,$3,$4,'registry.refresh','queued')", [d.principal.tenantId, randomUUID(), d.projectId, other.actorId]))).rejects.toBeTruthy();
  });
  it('enforces append-only audit/events and rejects a forged chain insert', async () => {
    const d = await setup();
    const { run } = await d.store.createRun(d.principal, { projectId: d.projectId, kind: 'registry.refresh' }, 'audit-immutability');
    await d.asAdmin(async c => {
      await expect(c.query("UPDATE audit_ledger SET hash='forged'")).rejects.toBeTruthy();
      await expect(c.query('DELETE FROM run_events')).rejects.toBeTruthy();
    });
    await expect(d.store.transaction(d.principal, 'test.forgery', c => c.query("INSERT INTO audit_ledger(tenant_id,sequence,id,body,previous_hash,hash) VALUES($1,2,$2,'{}','','forged')", [d.principal.tenantId, randomUUID()]))).rejects.toBeTruthy();
    expect(await d.store.verifyAudit(d.principal)).toMatchObject({ valid: true, checked: 1 });
    expect((await d.store.events(d.principal, run.id)).events).toHaveLength(1);
  });
  it.each(['deny', 'ask'] as const)('policy %s blocks admission with a durable decision audit and no run or outbox', async effect => {
    const d = await setup();
    const policy: PolicySet = { tenantId: d.principal.tenantId, organizationId: d.principal.tenantId, version: 'test-policy-v1', rules: [{ id: 'gate', effect, match: { tool: 'registry', operation: 'refresh' } }] };
    const store = new Store(d.database, policy);
    await expect(store.createRun(d.principal, { projectId: d.projectId, kind: 'registry.refresh' }, 'denied-admission')).rejects.toMatchObject({ code: effect === 'deny' ? 'POLICY_DENIED' : 'APPROVAL_REQUIRED' });
    expect(await store.listRuns(d.principal)).toEqual([]);
    expect(await store.claimOutbox(d.principal, 'dispatcher')).toEqual([]);
    expect(await store.verifyAudit(d.principal)).toMatchObject({ valid: true, checked: 1 });
  });
  it('persists cancellation intent, fences late registry writes/completion, and records one final cancellation', async () => {
    const d = await setup();
    const { run } = await d.store.createRun(d.principal, { projectId: d.projectId, kind: 'registry.refresh' }, 'cancel-create-key');
    await d.store.transitionRun(d.principal, run.id, 'running', 'workflow.begin');
    await d.store.requestCancellation(d.principal, run.id, 'cancel-request-key');
    expect((await d.store.getRun(d.principal, run.id))?.status).toBe('cancellation_requested');
    await expect(d.store.saveRegistry(d.principal, run.id, 'snapshot', [], [])).rejects.toMatchObject({ code: 'RUN_NOT_RUNNING' });
    await expect(d.store.transitionRun(d.principal, run.id, 'completed', 'workflow.end')).rejects.toMatchObject({ code: 'INVALID_RUN_TRANSITION' });
    await d.store.transitionRun(d.principal, run.id, 'cancelled', 'workflow.cancelled');
    await d.store.transitionRun(d.principal, run.id, 'cancelled', 'workflow.cancelled');
    expect((await d.store.events(d.principal, run.id)).events.map(e => e.sequence)).toEqual([1, 2, 3, 4]);
    expect((await d.store.claimOutbox(d.principal, 'dispatcher')).map(o => o.action).sort()).toEqual(['cancel', 'start']);
    expect(await d.store.verifyAudit(d.principal)).toMatchObject({ valid: true, checked: 4 });
  });
});

describe('live Fastify HTTP and WebSocket integration', () => {
  it('authenticates, validates schemas, admits durably and returns generated OpenAPI', async () => {
    const d = await server();
    expect((await d.app.inject({ url: '/v1/runs' })).statusCode).toBe(401);
    expect((await d.app.inject({ url: '/health/ready' })).statusCode).toBe(200);
    expect((await d.app.inject({ url: '/v1/runs', headers: { ...d.auth, origin: 'https://untrusted.test' } })).statusCode).toBe(401);
    const input = { projectId: d.projectId, kind: 'registry.refresh' };
    expect((await d.app.inject({ method: 'POST', url: '/v1/runs', headers: d.auth, payload: input })).statusCode).toBe(400);
    const response = await d.app.inject({ method: 'POST', url: '/v1/runs', headers: { ...d.auth, 'idempotency-key': 'http-admission-key' }, payload: input });
    expect(response.statusCode).toBe(202);
    expect(response.json().run.policyVersion).toBe('registry-v1');
    await d.store.transitionRun(d.principal, response.json().run.id as string, 'running', 'http.workflow.begin');
    const audit = await d.app.inject({ url: '/v1/audit/export?after=0&limit=1', headers: d.auth });
    expect(audit.headers['x-sand-has-more']).toBe('true');
    expect(audit.headers['x-sand-next-cursor']).toBe('1');
    expect(JSON.parse(audit.body.trim()).sequence).toBe(1);
    const auditTail = await d.app.inject({ url: '/v1/audit/export?after=1&limit=1', headers: d.auth });
    expect(auditTail.headers['x-sand-has-more']).toBe('false');
    expect(JSON.parse(auditTail.body.trim()).sequence).toBe(2);
    const contract = (await d.app.inject({ url: '/v1/openapi.json', headers: d.auth })).json();
    expect(contract.paths['/v1/runs'].post.requestBody).toBeDefined();
    expect((await d.app.inject({ url: '/v1/models', headers: d.auth })).json()).toEqual({ models: [], providers: [], observedAt: null });
    expect((await d.app.inject({ method: 'POST', url: '/v1/runs', headers: { ...d.auth, 'idempotency-key': 'invalid-kind-key' }, payload: { ...input, kind: 'agent.execute' } })).statusCode).toBe(400);
  });
  it('replays persisted events after disconnect with stable IDs and duplicate replay consumers can deduplicate', async () => {
    const d = await server({ pollMs: 10 });
    const { run } = await d.store.createRun(d.principal, { projectId: d.projectId, kind: 'registry.refresh' }, 'websocket-create');
    const one = await connect(`${d.address}/v1/runs/${run.id}/stream?after=0`);
    await until(() => eventSequences(one.messages).length === 1);
    one.socket.send(JSON.stringify({ type: 'ack', sequence: 1 })); one.socket.terminate();
    await d.store.transitionRun(d.principal, run.id, 'running', 'workflow.begin');
    await d.store.transitionRun(d.principal, run.id, 'failed', 'workflow.failed', { errorCode: 'PROVIDER_UNAVAILABLE' });
    const two = await connect(`${d.address}/v1/runs/${run.id}/stream?after=1`);
    await until(() => eventSequences(two.messages).length === 2);
    expect(eventSequences(two.messages)).toEqual([2, 3]);
    const three = await connect(`${d.address}/v1/runs/${run.id}/stream?after=0`);
    await until(() => eventSequences(three.messages).length === 3);
    const all = (await d.store.events(d.principal, run.id)).events;
    const replayEvents = three.messages.flatMap(m => (m.events ?? []) as { id: string }[]);
    expect(replayEvents.map(e => e.id)).toEqual(all.map(e => e.id));
    expect(new Set([...all, ...replayEvents].map(e => e.id)).size).toBe(3);
    await expect(connect(`${d.address}/v1/runs/${run.id}/stream?after=1`, 'Bearer invalid')).rejects.toBeTruthy();
  });
  it('bounds backlog via snapshots and disconnects consumers that stop acknowledging', async () => {
    const d = await server({ pollMs: 10, maxInFlight: 1, maxBacklog: 2, ackTimeoutMs: 80 });
    const { run } = await d.store.createRun(d.principal, { projectId: d.projectId, kind: 'registry.refresh' }, 'slow-stream-run');
    const slow = await connect(`${d.address}/v1/runs/${run.id}/stream?after=0`);
    const closed = new Promise<number>(resolve => slow.socket.on('close', code => resolve(code)));
    expect(await closed).toBe(1013);
    await d.store.transitionRun(d.principal, run.id, 'running', 'workflow.begin');
    await d.store.transitionRun(d.principal, run.id, 'completed', 'workflow.end');
    const backlog = await connect(`${d.address}/v1/runs/${run.id}/stream?after=0`);
    await until(() => backlog.messages.some(m => m.type === 'snapshot_required'));
    const snapshot = await d.store.snapshot(d.principal, run.id);
    expect(snapshot.lastSequence).toBe(3);
    expect((await d.store.events(d.principal, run.id, 0, 2)).hasMore).toBe(true);
    expect((await d.store.events(d.principal, run.id, 2)).events.map(e => e.sequence)).toEqual([3]);
  });
  it('fails closed for production and unconfigured authentication', () => {
    expect(() => readLocalConfiguration({ NODE_ENV: 'production' })).toThrow('Production startup is disabled');
    expect(() => readLocalConfiguration({})).toThrow('local-development');
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('real network PostgreSQL staging (SKIPPED without TEST_DATABASE_URL runtime role)', () => {
  it('validates the live runtime role and tenant-scoped transaction', async () => {
    if (!process.env.TEST_TENANT_ID || !process.env.TEST_ACTOR_ID) throw new Error('TEST_TENANT_ID and TEST_ACTOR_ID must identify a pre-provisioned staging tenant.');
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    try {
      const store = new Store(new PgDatabase(pool));
      await store.assertRuntimeRole();
      expect(await store.readiness({ tenantId: process.env.TEST_TENANT_ID, actorId: process.env.TEST_ACTOR_ID })).toBe(true);
    } finally { await pool.end(); }
  });
});
