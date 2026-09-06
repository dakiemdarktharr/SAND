import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { DatabaseClient } from './types.js';
import { digest } from './store.js';

export const migrationsDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));
export async function migrate(client: DatabaseClient): Promise<string[]> {
  await client.query('BEGIN');
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('sand/schema-migration'))");
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
    const applied: string[] = [];
    for (const file of (await readdir(migrationsDirectory)).filter(name => /^\d+.*\.sql$/.test(name)).sort()) {
      const sql = await readFile(`${migrationsDirectory}/${file}`, 'utf8');
      const checksum = digest(sql);
      const prior = (await client.query('SELECT checksum FROM schema_migrations WHERE version=$1', [file])).rows[0];
      if (prior) {
        if (prior.checksum !== checksum) throw new Error(`Migration checksum mismatch: ${file}. Restore the original migration and add a new version.`);
        continue;
      }
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)', [file, checksum]);
      applied.push(file);
    }
    await client.query('COMMIT');
    return applied;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}

/** Explicit development fixture: persists a real tenant/project, never fabricated API responses. */
export async function bootstrapDevelopment(client: DatabaseClient, tenantId: string, projectId: string): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query("SELECT set_config('sand.tenant_id',$1,true)", [tenantId]);
    await client.query("INSERT INTO tenants(id,name) VALUES($1,'Local development organization') ON CONFLICT DO NOTHING", [tenantId]);
    await client.query("INSERT INTO projects(tenant_id,id,name) VALUES($1,$2,'Local development project') ON CONFLICT DO NOTHING", [tenantId, projectId]);
    await client.query('INSERT INTO audit_heads(tenant_id) VALUES($1) ON CONFLICT DO NOTHING', [tenantId]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}

export async function grantRuntimeRole(client: DatabaseClient, role: string): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role)) throw new Error('Invalid runtime database role name.');
  await client.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
  await client.query(`GRANT SELECT ON tenants,projects TO "${role}"`);
  await client.query(`GRANT SELECT,INSERT,UPDATE ON runs,outbox,audit_heads TO "${role}"`);
  await client.query(`GRANT SELECT,INSERT ON run_events,audit_ledger,idempotency_records,registry_snapshots TO "${role}"`);
}
