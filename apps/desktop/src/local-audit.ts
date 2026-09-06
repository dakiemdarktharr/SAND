import { mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { digest } from './repository';

/** Local development ledger; a separate external anchor is required against whole-ledger rewriting. */
export class LocalAudit {
  private queue: Promise<unknown> = Promise.resolve();
  private sequence = 0;
  private head = '0'.repeat(64);
  constructor(private readonly file: string) {}
  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const text = await readFile(this.file, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return ''; throw error; });
    for (const line of text.split('\n').filter(Boolean)) {
      const record = JSON.parse(line) as { sequence: number; previousHash: string; hash: string; event: unknown };
      const computed = digest(JSON.stringify({ sequence: record.sequence, previousHash: record.previousHash, event: record.event }));
      if (record.previousHash !== this.head || record.sequence !== this.sequence + 1 || computed !== record.hash) throw new Error('Local audit integrity check failed. Restore the ledger before reopening SAND.');
      this.sequence = record.sequence; this.head = record.hash;
    }
  }
  append(event: Record<string, unknown>): Promise<void> {
    const write = this.queue.then(async () => {
      const record = { sequence: this.sequence + 1, previousHash: this.head, event: { ...event, at: new Date().toISOString(), policyVersion: 'desktop-user-selected-v1' } };
      const hash = digest(JSON.stringify(record));
      const handle = await open(this.file, 'a', 0o600);
      try { await handle.writeFile(JSON.stringify({ ...record, hash }) + '\n'); await handle.sync(); } finally { await handle.close(); }
      this.sequence = record.sequence; this.head = hash;
    });
    // A failed audit write poisons subsequent operations: no unaudited fall-through.
    this.queue = write;
    return write;
  }
}
