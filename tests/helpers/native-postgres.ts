import EmbeddedPostgres from 'embedded-postgres';
import { Pool } from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import { bootstrapDevelopment, grantRuntimeRole, migrate } from '../../services/control-plane/src/migrations';
import { PgDatabase, Store } from '../../services/control-plane/src/store';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('NO_TEST_PORT');
  await new Promise<void>((yes, no) => server.close(error => error ? no(error) : yes()));
  return address.port;
}
/** Real native PostgreSQL. Isolated generated test data retained under ignored .runtime; never a production adapter. */
export async function nativePostgres() {
  const runtimeRoot = resolve('.runtime');
  await mkdir(runtimeRoot, { recursive: true });
  const directory = await mkdtemp(join(runtimeRoot, 'postgres-test-'));
  const port = await freePort();
  const password = randomBytes(24).toString('hex');
  const runtimePassword = randomBytes(24).toString('hex');
  const postgres = new EmbeddedPostgres({
    databaseDir: join(directory, 'db'), port, user: 'sand_test_admin', password,
    authMethod: 'scram-sha-256', persistent: true, createPostgresUser: false,
    initdbFlags: ['--encoding=UTF8'], postgresFlags: ['-h', '127.0.0.1'],
    onLog: () => undefined, onError: () => undefined,
  });
  await postgres.initialise();
  await postgres.start();
  const admin = new Pool({ host: '127.0.0.1', port, user: 'sand_test_admin', password, database: 'postgres', max: 2 });
  const client = await admin.connect();
  const principal = { tenantId: randomUUID(), actorId: randomUUID() };
  const projectId = randomUUID();
  try {
    await migrate(client);
    // Password is generated hex, never a user-controlled SQL literal or log field.
    await client.query("CREATE ROLE sand_runtime LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '" + runtimePassword + "'");
    await grantRuntimeRole(client, 'sand_runtime');
    await bootstrapDevelopment(client, principal.tenantId, projectId);
  } catch (error) { client.release(); await admin.end(); await postgres.stop(); throw error; }
  client.release();
  const runtime = new Pool({ host: '127.0.0.1', port, user: 'sand_runtime', password: runtimePassword, database: 'postgres', max: 6, statement_timeout: 10_000 });
  const store = new Store(new PgDatabase(runtime));
  await store.assertRuntimeRole();
  return {
    store, principal, projectId, admin, runtime, directory,
    async close() { await runtime.end(); await admin.end(); await postgres.stop(); },
  };
}
