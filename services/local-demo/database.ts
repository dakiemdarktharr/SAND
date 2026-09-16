import { PGlite } from '@electric-sql/pglite';
import { mkdir, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { bootstrapDevelopment, grantRuntimeRole, migrate } from '../control-plane/src/migrations.js';
import { Store, type Database, type DatabaseClient, type Principal } from '../control-plane/src/store.js';
import type { PolicySet } from '../../packages/policy/src/index.js';

export const principal: Principal = { tenantId: '10000000-0000-4000-8000-000000000001', actorId: '10000000-0000-4000-8000-000000000002' };
export const projectId = '10000000-0000-4000-8000-000000000003';
export const blockedProjectId = '10000000-0000-4000-8000-000000000004';
const policy: PolicySet = {tenantId:principal.tenantId, organizationId:principal.tenantId, version:'local-demo-v1', rules:[
  {id:'demo-project-registry', effect:'allow', match:{projectId, tool:'registry', operation:'refresh', environment:'development', dataSensitivity:'public', arguments:[{path:['kind'], equals:'registry.refresh'}]}},
]};

/** Explicit development-only PostgreSQL WASM adapter; never imported by the network API or worker. */
export async function openLocalDatabase(directory: string) {
  if (process.env.NODE_ENV === 'production') throw new Error('Local demo is disabled in production.');
  await mkdir(directory, {recursive:true});
  const lockPath = path.join(directory, '.sand-demo.lock');
  const lock = await open(lockPath, 'wx'); // Refuse concurrent owners; never silently remove stale locks.
  const db = new PGlite(path.join(directory, 'postgres'), {relaxedDurability:false});
  try {
    await db.waitReady;
    const client: DatabaseClient = {
      async query<T extends Record<string, unknown>>(sql: string, values?: unknown[]) {
        if (!values && sql.includes(';')) return {rows: ((await db.exec(sql)).at(-1)?.rows ?? []) as T[]};
        return db.query<T>(sql, values);
      },
      release() {},
    };
    const versions = await migrate(client);
    await bootstrapDevelopment(client, principal.tenantId, projectId);
    if (!(await client.query("SELECT 1 FROM pg_roles WHERE rolname='sand_demo_runtime'")).rows.length) {
      await client.query('CREATE ROLE sand_demo_runtime NOSUPERUSER NOBYPASSRLS');
    }
    await grantRuntimeRole(client, 'sand_demo_runtime');
    await client.query('SET ROLE sand_demo_runtime');
    let tail = Promise.resolve();
    const database: Database = {
      async connect() {
        const before = tail;
        let unlock!: () => void;
        tail = new Promise<void>(resolve => { unlock = resolve; });
        await before;
        return {query:client.query.bind(client), release:unlock};
      },
    };
    const store = new Store(database, policy);
    await store.assertRuntimeRole();
    return {store, versions, close:async () => {
      await tail;
      await db.close();
      await lock.close();
      await unlink(lockPath);
    }};
  } catch (error) {
    await db.close().catch(() => undefined);
    await lock.close();
    await unlink(lockPath);
    throw error;
  }
}
