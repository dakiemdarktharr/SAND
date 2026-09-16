import { it, expect } from 'vitest';
import { EgressBroker } from './egress';
it('rejects private destinations, plain HTTP, credentials and origin mismatch', async () => {
  const broker = new EgressBroker();
  for (const url of [
    'http://example.com',
    'https://127.0.0.1/',
    'https://[::1]/',
    'https://169.254.169.254/',
    'https://user:secret@example.com/',
  ])
    await expect(broker.fetch(url, {}, [new URL(url).origin])).rejects.toThrow();
  await expect(
    broker.fetch('https://example.com', {}, ['https://other.example']),
  ).rejects.toThrow();
});
