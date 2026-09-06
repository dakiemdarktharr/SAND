import { test, expect, _electron as electron } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { nativePostgres } from '../helpers/native-postgres';
import { buildServer } from '../../services/control-plane/src/server';
import { createActivities } from '../../services/workflows/src/activities';
import { OutboxDispatcher } from '../../services/workflows/src/dispatcher';
import { taskQueueFor } from '../../services/workflows/src/contracts';
import { ModelRegistry } from '../../packages/providers/src/registry';

test('desktop → authenticated API → PostgreSQL/outbox → Temporal → public provider → visible registry', async () => {
  test.skip(process.env.SAND_FULLSTACK_E2E !== '1', 'Set SAND_FULLSTACK_E2E=1 to launch real local PostgreSQL, Temporal and public OpenRouter discovery.');
  test.setTimeout(180_000);
  const db = await nativePostgres();
  const token = randomBytes(32).toString('hex');
  const api = await buildServer({ store: db.store, principal: db.principal, token, logger: false });
  const address = await api.listen({ host: '127.0.0.1', port: 0 });
  const temporal = await TestWorkflowEnvironment.createLocal({ server: { ip: '127.0.0.1', ui: false } });
  const worker = await Worker.create({
    connection: temporal.nativeConnection, taskQueue: taskQueueFor(db.principal),
    workflowsPath: fileURLToPath(new URL('../../services/workflows/src/workflow.ts', import.meta.url)),
    activities: createActivities(db.store, new ModelRegistry({ openrouterPublicDiscovery: true }), db.principal),
  });
  const stop = new AbortController();
  const dispatch = new OutboxDispatcher(db.store, temporal.client, db.principal).run(stop.signal);
  await mkdir(resolve('.runtime'), { recursive: true });
  const testRoot = await mkdtemp(resolve('.runtime/fullstack-ui-'));
  const repository = join(testRoot, 'repository');
  await mkdir(repository);
  await writeFile(join(repository, 'README.md'), '# Full stack acceptance repository\n');
  const started = performance.now();
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, SAND_E2E: '1', SAND_TEST_REPOSITORY: repository, SAND_TEST_USER_DATA: join(testRoot, 'user-data'), SAND_API_TOKEN: token, SAND_API_URL: address },
  });
  try {
    await worker.runUntil(async () => {
      const page = await app.firstWindow();
      await expect(page.getByRole('button', { name: 'Start discovery', exact: true })).toBeEnabled({ timeout: 30_000 });
      await page.getByRole('button', { name: 'Start discovery', exact: true }).click();
      await expect.poll(async () => (await db.store.listRuns(db.principal))[0]?.status, { timeout: 60_000 }).toBe('completed');
      await page.getByRole('button', { name: 'Model registry', exact: true }).click();
      await expect(page.getByText('openrouter', { exact: true }).first()).toBeVisible({ timeout: 15_000 });
      const registry = await db.store.listModels(db.principal);
      expect(registry.models.length).toBeGreaterThan(0);
      expect((await db.store.verifyAudit(db.principal)).valid).toBe(true);
      await mkdir(resolve('artifacts/local'), { recursive: true });
      await page.screenshot({ path: 'artifacts/local/fullstack-registry.png', fullPage: true });
      await writeFile('artifacts/local/fullstack-evidence.json', JSON.stringify({
        at: new Date().toISOString(), nativePostgres: true, temporal: true, publicProvider: 'openrouter',
        modelCount: registry.models.length, auditValid: true, elapsedMs: Math.round(performance.now() - started),
        authenticatedInference: 'not tested', runId: (await db.store.listRuns(db.principal))[0]?.id,
      }, null, 2));
    });
  } finally {
    stop.abort();
    await dispatch;
    await app.close();
    await temporal.teardown();
    await api.close();
    await db.close();
  }
});
