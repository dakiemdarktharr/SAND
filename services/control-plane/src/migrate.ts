import { Pool } from 'pg';
import { bootstrapDevelopment, grantRuntimeRole, migrate } from './migrations.js';

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL for the dedicated migrator role is required.');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const client = await pool.connect();
  try {
    const applied = await migrate(client);
    const role = process.env.SAND_RUNTIME_DB_ROLE;
    if (role) await grantRuntimeRole(client, role);
    if (process.env.SAND_BOOTSTRAP_LOCAL === 'true') {
      if (process.env.NODE_ENV === 'production') throw new Error('Development bootstrap is prohibited in production.');
      if (!process.env.SAND_TENANT_ID || !process.env.SAND_PROJECT_ID) throw new Error('Set SAND_TENANT_ID and SAND_PROJECT_ID for development bootstrap.');
      await bootstrapDevelopment(client, process.env.SAND_TENANT_ID, process.env.SAND_PROJECT_ID);
    }
    console.log(JSON.stringify({ event: 'migrations.applied', versions: applied }));
  } finally { client.release(); await pool.end(); }
}
main().catch(() => { console.error(JSON.stringify({ code: 'MIGRATION_FAILED', remediation: 'Check migrator credentials, immutable migration checksums and bootstrap identifiers. Raw database errors are excluded.' })); process.exitCode = 1; });
