import { Pool } from 'pg';
import { PgDatabase, Store } from './store.js';
import { buildServer } from './server.js';
import { startTelemetry } from '../../../packages/telemetry/src/index.js';

export function readLocalConfiguration(env: NodeJS.ProcessEnv = process.env) {
  if (env.NODE_ENV === 'production') throw new Error('Production startup is disabled: OIDC, TLS and production identity are not implemented.');
  if (env.SAND_AUTH_MODE !== 'local-development') throw new Error('Set SAND_AUTH_MODE=local-development explicitly. Only loopback development identity is supported.');
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required. There is no in-memory production fallback.');
  if (!env.SAND_API_TOKEN || env.SAND_API_TOKEN.length < 32) throw new Error('SAND_API_TOKEN must contain at least 32 characters.');
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(env.SAND_TENANT_ID ?? '') || !uuid.test(env.SAND_ACTOR_ID ?? '')) throw new Error('SAND_TENANT_ID and SAND_ACTOR_ID must be configured UUIDs.');
  return { databaseUrl: env.DATABASE_URL, token: env.SAND_API_TOKEN, principal: { tenantId: env.SAND_TENANT_ID!, actorId: env.SAND_ACTOR_ID! } };
}

async function main() {
  const config = readLocalConfiguration();
  const telemetry = startTelemetry('sand-control-plane');
  const pool = new Pool({ connectionString: config.databaseUrl, max: 10, connectionTimeoutMillis: 5000, application_name: 'sand-control-plane', statement_timeout: 10000 });
  pool.on('error', () => { console.error(JSON.stringify({ level: 'error', code: 'DATABASE_POOL_ERROR' })); });
  const store = new Store(new PgDatabase(pool));
  await store.assertRuntimeRole();
  const app = await buildServer({ store, principal: config.principal, token: config.token, logger: true });
  app.addHook('onClose', async () => { await pool.end(); await telemetry?.shutdown(); });
  const stop = () => { void app.close(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  await app.listen({ host: '127.0.0.1', port: 4310 });
}
if (process.argv[1]?.replaceAll('\\', '/').endsWith('/control-plane/src/main.ts')) {
  main().catch(() => { console.error(JSON.stringify({ level: 'error', code: 'CONTROL_PLANE_STARTUP_FAILED', remediation: 'Check development auth configuration, runtime database role and migrations. Secrets and raw errors are deliberately omitted.' })); process.exitCode = 1; });
}
