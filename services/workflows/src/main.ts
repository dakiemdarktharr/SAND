import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { Client, Connection } from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';
import { PgDatabase, Store } from '../../control-plane/src/store';
import { ModelRegistry, registryConfiguration } from '../../../packages/providers/src/registry';
import { createActivities } from './activities';
import { OutboxDispatcher } from './dispatcher';
import { taskQueueFor } from './contracts';
import { startTelemetry } from '../../../packages/telemetry/src/index';

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') throw new Error('PRODUCTION_WORKER_NOT_CONFIGURED');
  const databaseUrl = process.env.DATABASE_URL;
  const tenantId = process.env.SAND_TENANT_ID;
  const actorId = process.env.SAND_ACTOR_ID;
  if (!databaseUrl || !tenantId || !actorId) throw new Error('WORKER_CONFIGURATION_REQUIRED');
  const address = process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233';
  if (!/^127\.0\.0\.1:\d+$/.test(address)) throw new Error('DEVELOPMENT_TEMPORAL_MUST_BE_LOOPBACK');
  const telemetry = startTelemetry('sand-registry-worker');
  const pool = new Pool({ connectionString: databaseUrl, max: 5, connectionTimeoutMillis: 3000, statement_timeout: 10000 });
  const store = new Store(new PgDatabase(pool));
  await store.assertRuntimeRole();
  const principal = { tenantId, actorId };
  const taskQueue = taskQueueFor(principal);
  const connection = await Connection.connect({ address });
  const native = await NativeConnection.connect({ address });
  const client = new Client({ connection, namespace: process.env.TEMPORAL_NAMESPACE ?? 'default' });
  const worker = await Worker.create({
    connection: native, namespace: process.env.TEMPORAL_NAMESPACE ?? 'default', taskQueue,
    workflowsPath: fileURLToPath(new URL('./workflow.ts', import.meta.url)),
    activities: createActivities(store, new ModelRegistry(registryConfiguration(process.env)), principal),
    maxConcurrentActivityTaskExecutions: 4,
    maxHeartbeatThrottleInterval: '1 second',
    shutdownGraceTime: '10 seconds',
  });
  const stop = new AbortController();
  const shutdown = () => { if (!stop.signal.aborted) { stop.abort(); worker.shutdown(); } };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  console.info(JSON.stringify({ event: 'worker.started', runtime: 'trusted-infrastructure-process', taskQueue, production: false }));
  try { await Promise.all([worker.run(), new OutboxDispatcher(store, client, principal).run(stop.signal)]); }
  finally {
    stop.abort(); await connection.close(); await native.close(); await pool.end(); await telemetry?.shutdown();
  }
}
main().catch(() => { console.error(JSON.stringify({ error: 'WORKER_START_OR_EXECUTION_FAILED', remediation: 'Check development configuration, database role, and Temporal availability.' })); process.exitCode = 1; });
