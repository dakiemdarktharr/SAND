import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nativePostgres } from '../helpers/native-postgres.js';
import { buildServer } from '../../services/control-plane/src/server.js';
import { bootstrapDevelopment } from '../../services/control-plane/src/migrations.js';

describe('native PostgreSQL over loopback: real multi-connection concurrency and persisted API recovery', () => {
  let database: Awaited<ReturnType<typeof nativePostgres>>;
  beforeAll(async () => { database = await nativePostgres(); }, 120_000);
  afterAll(async () => { await database?.close(); }, 30_000);

  it('serializes concurrent identical admissions and prevents duplicate outbox/effects', async () => {
    const { store, principal, projectId, runtime } = database;
    const key = `native-admission-${randomUUID()}`;
    const input = { projectId, kind: 'registry.refresh' as const };
    const receipts = await Promise.all(Array.from({ length: 16 }, () => store.createRun(principal, input, key)));
    expect(new Set(receipts.map(receipt => receipt.run.id)).size).toBe(1);
    expect(receipts.filter(receipt => !receipt.replayed)).toHaveLength(1);
    const run = receipts[0]!.run;
    const effects = await store.transaction(principal, 'test.receipts', async client => client.query('SELECT action FROM outbox WHERE run_id=$1', [run.id]));
    expect(effects.rows).toEqual([{ action: 'start' }]);
    expect((await store.events(principal, run.id)).events).toHaveLength(1);
    expect(await store.verifyAudit(principal)).toMatchObject({ valid: true });
    expect(runtime.totalCount).toBeGreaterThan(1);
  }, 30_000);

  it('retains accepted run/event/audit after API restart and rejects a cross-tenant read through real RLS', async () => {
    const { store, principal, projectId, admin } = database;
    const token = 'native-test-only-secret-0123456789-abcdef';
    const headers = { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() };
    const firstApi = await buildServer({ store, principal, token });
    const response = await firstApi.inject({ method: 'POST', url: '/v1/runs', headers, payload: { projectId, kind: 'registry.refresh' } });
    expect(response.statusCode).toBe(202);
    const runId = response.json().run.id as string;
    await firstApi.close();
    const secondApi = await buildServer({ store, principal, token });
    try {
      const recovered = await secondApi.inject({ url: `/v1/runs/${runId}/events?after=0`, headers });
      expect(recovered.statusCode).toBe(200);
      expect(recovered.json().events).toHaveLength(1);
      expect((await secondApi.inject({ url: '/v1/audit/verify', headers })).json().valid).toBe(true);
    } finally { await secondApi.close(); }
    const other = { tenantId: randomUUID(), actorId: randomUUID() };
    const adminClient = await admin.connect();
    try { await bootstrapDevelopment(adminClient, other.tenantId, randomUUID()); } finally { adminClient.release(); }
    expect(await store.getRun(other, runId)).toBeNull();
    await expect(store.events(other, runId)).rejects.toMatchObject({ code: 'RUN_NOT_FOUND' });
    await expect(store.snapshot(other, runId)).rejects.toMatchObject({ code: 'RUN_NOT_FOUND' });
  }, 30_000);

  it('fences a completion racing cancellation and preserves a consistent event horizon', async () => {
    const { store, principal, projectId } = database;
    const { run } = await store.createRun(principal, { projectId, kind: 'registry.refresh' }, randomUUID());
    await store.transitionRun(principal, run.id, 'running', 'workflow.begin');
    const race = await Promise.allSettled([
      store.requestCancellation(principal, run.id, randomUUID()),
      store.transitionRun(principal, run.id, 'completed', 'workflow.completed'),
      store.events(principal, run.id),
    ]);
    const status = (await store.getRun(principal, run.id))!.status;
    expect(['completed', 'cancellation_requested']).toContain(status);
    if (status === 'cancellation_requested') {
      await expect(store.transitionRun(principal, run.id, 'completed', 'late.completed')).rejects.toMatchObject({ code: 'INVALID_RUN_TRANSITION' });
      await store.transitionRun(principal, run.id, 'cancelled', 'workflow.cancelled');
    }
    const during = race[2]!;
    expect(during.status).toBe('fulfilled');
    if (during.status === 'fulfilled') { const page = during.value; expect(page.events.every(event => event.sequence <= page.lastSequence)).toBe(true); }
    const final = await store.events(principal, run.id);
    expect(final.events.map(event => event.sequence)).toEqual(Array.from({ length: final.events.length }, (_, index) => index + 1));
    expect(await store.verifyAudit(principal)).toMatchObject({ valid: true });
  }, 30_000);
});
