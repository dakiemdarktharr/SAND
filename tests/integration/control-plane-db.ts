import { PGlite } from '@electric-sql/pglite';
import { bootstrapDevelopment, grantRuntimeRole, migrate } from '../../services/control-plane/src/migrations.js';
import { Store, type Database, type DatabaseClient, type Principal } from '../../services/control-plane/src/store.js';

/** Actual PostgreSQL engine compiled to WASM, only imported from tests. Single-session access is serialized. */
export async function createTestDb() {
  const db = new PGlite();
  await db.waitReady;
  const client: DatabaseClient = {
    async query<T extends Record<string, unknown>>(sql: string, values?: unknown[]) {
      if (!values && sql.includes(';')) {
        const results = await db.exec(sql);
        return { rows: (results.at(-1)?.rows ?? []) as T[] };
      }
      return db.query<T>(sql, values);
    },
    release() {},
  };
  await migrate(client);
  const principal: Principal = { tenantId: '10000000-0000-4000-8000-000000000001', actorId: '10000000-0000-4000-8000-000000000002' };
  const projectId = '10000000-0000-4000-8000-000000000003';
  await bootstrapDevelopment(client, principal.tenantId, projectId);
  await client.query('CREATE ROLE sand_test_runtime NOSUPERUSER NOBYPASSRLS');
  await grantRuntimeRole(client, 'sand_test_runtime');
  await client.query('SET ROLE sand_test_runtime');
  let tail = Promise.resolve();
  const database: Database = {
    async connect() {
      const before = tail;
      let unlock!: () => void;
      tail = new Promise<void>(resolve => { unlock = resolve; });
      await before;
      return { query: client.query.bind(client), release: unlock };
    },
  };
  const asAdmin = async <T>(fn: (c: DatabaseClient) => Promise<T>): Promise<T> => {
    const connection = await database.connect();
    try { await connection.query('RESET ROLE'); return await fn(connection); }
    finally { await connection.query('SET ROLE sand_test_runtime'); connection.release(); }
  };
  return { db, database, store: new Store(database), principal, projectId, asAdmin, close: () => db.close() };
}
