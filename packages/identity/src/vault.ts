import { readFile, open, rename, mkdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { StudioError } from '../../studio/src/schema.js';
export interface OsCryptography {
  available(): Promise<boolean>;
  encrypt(text: string): Promise<Buffer>;
  decrypt(bytes: Buffer): Promise<string>;
}
export class CredentialVault {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private file: string,
    private os: OsCryptography,
  ) {}
  async available() {
    return this.os.available();
  }
  private async read(): Promise<Record<string, string>> {
    if (!(await this.os.available()))
      throw new StudioError(
        'KEYCHAIN_UNAVAILABLE',
        'OS secret storage không khả dụng; không lưu plaintext.',
      );
    const info = await lstat(this.file).catch((e) => {
      if (e.code === 'ENOENT') return null;
      throw e;
    });
    if (!info) return {};
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 256000)
      throw new StudioError('VAULT_INVALID', 'Credential store không hợp lệ.');
    const data = JSON.parse(await this.os.decrypt(await readFile(this.file))) as unknown;
    if (
      !data ||
      typeof data !== 'object' ||
      Array.isArray(data) ||
      Object.values(data).some((v) => typeof v !== 'string')
    )
      throw new StudioError('VAULT_INVALID', 'Credential store không hợp lệ.');
    return data as Record<string, string>;
  }
  async get(key: string) {
    await this.queue;
    return (await this.read())[key];
  }
  set(key: string, value: string | undefined) {
    const next = this.queue.then(async () => {
      const data = await this.read();
      if (value === undefined) delete data[key];
      else data[key] = value;
      const encoded = await this.os.encrypt(JSON.stringify(data));
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = this.file + '.' + randomUUID() + '.tmp';
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(encoded);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.file);
    });
    this.queue = next.catch(() => undefined);
    return next;
  }
}
