import EmbeddedPostgres from 'embedded-postgres';
import { Pool } from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
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
  let startupLog = '';
  const redact = (text: string) => text.replaceAll(password, '[REDACTED]').replaceAll(runtimePassword, '[REDACTED]').slice(-8000);
  const postgres = new EmbeddedPostgres({
    databaseDir: join(directory, 'db'), port, user: 'sand_test_admin', password,
    authMethod: 'scram-sha-256', persistent: true, createPostgresUser: false,
    initdbFlags: ['--encoding=UTF8'], postgresFlags: ['-h', '127.0.0.1'],
    onLog: message => { startupLog = redact(startupLog + String(message)); }, onError: () => undefined,
  });
  let stop = () => postgres.stop();
  try {
    await postgres.initialise();
    if (process.platform === 'win32') {
      // pg_ctl creates the restricted Windows token PostgreSQL expects. Direct
      // postgres.exe spawning fails on elevated hosted runners. No service/user is installed.
      const binaryPackage = '@embedded-postgres/windows-x64';
      const { pg_ctl } = await import(binaryPackage) as { pg_ctl: string };
      // Ignore stdio so a long-lived server cannot inherit Node's pipe handles.
      const execute = (binary: string, args: string[]) => new Promise<void>((yes, no) => {
        const child = spawn(binary, args, { windowsHide: true, stdio: 'ignore', env: { ...process.env, LC_MESSAGES: 'C' } });
        const timer = setTimeout(() => { child.kill(); no(new Error('PG_CTL_TIMEOUT')); }, 35_000);
        child.once('error', error => { clearTimeout(timer); no(error); });
        child.once('exit', code => { clearTimeout(timer); if (code === 0) yes(); else no(new Error('PG_CTL_EXIT_'+code)); });
      });
      const databaseDir = join(directory, 'db');
      const logFile = join(directory, 'postgres.log');
      stop = async () => { await execute(pg_ctl, ['-D', databaseDir, '-w', '-t', '30', '-m', 'fast', 'stop']); };
      try {
        await execute(pg_ctl, ['-D', databaseDir, '-l', logFile, '-w', '-t', '30', '-o', '-p '+port+' -h 127.0.0.1', 'start']);
      } catch (error) {
        startupLog = redact(startupLog + await readFile(logFile, 'utf8').catch(() => ''));
        throw error;
      }
    } else await postgres.start();
  } catch (error) {
    await stop().catch(() => undefined);
    throw new Error('NATIVE_POSTGRES_BOOTSTRAP_FAILED: '+redact((error instanceof Error ? error.message : 'server exited without a library error')+'\n'+startupLog));
  }
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
  } catch (error) { client.release(); await admin.end(); await stop(); throw error; }
  client.release();
  const runtime = new Pool({ host: '127.0.0.1', port, user: 'sand_runtime', password: runtimePassword, database: 'postgres', max: 6, statement_timeout: 10_000 });
  const store = new Store(new PgDatabase(runtime));
  await store.assertRuntimeRole();
  return {
    store, principal, projectId, admin, runtime, directory,
    async close() { await runtime.end(); await admin.end(); await stop(); },
  };
}
