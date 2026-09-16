import { buildServer } from '../control-plane/src/server.js';
import { openLocalDatabase, principal } from './database.js';

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('Production mode prohibited');
  const directory = process.env.SAND_DEMO_DIRECTORY;
  const token = process.env.SAND_DEMO_TOKEN;
  if (!directory || !token || !process.send) throw new Error('Use npm run demo to launch this supervised local server.');
  const database = await openLocalDatabase(directory);
  const app = await buildServer({store:database.store, principal, token, logger:false});
  app.addHook('onClose', () => database.close());
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await app.close();
    if (process.connected) process.disconnect();
  };
  process.on('message', message => { if (message === 'stop') void stop(); });
  process.once('disconnect', () => { void stop(); });
  process.once('SIGTERM', () => { void stop(); });
  process.once('SIGINT', () => { void stop(); });
  const address = await app.listen({host:'127.0.0.1', port:0});
  const queue = await database.store.transaction(principal, 'demo.queue.inspect', async client => (await client.query('SELECT count(*)::int AS total, count(delivered_at)::int AS delivered FROM outbox')).rows[0]!);
  process.send({type:'ready', address, pid:process.pid, migrations:database.versions, outboxCount:queue.total, deliveredOutbox:queue.delivered});
}
main().catch(() => {
  console.error(JSON.stringify({event:'demo.server.failed', code:'LOCAL_DEMO_START_FAILED', remediation:'Use Node 24 and npm ci. Check the printed demo directory for disk permissions or an active/stale .sand-demo.lock; use a new demo directory instead of deleting data.'}));
  process.exitCode = 1;
  if (process.connected) process.disconnect();
});
