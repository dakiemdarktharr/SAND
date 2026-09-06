import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, link } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { RepositoryBroker, validateRelative, containsSecret, digest } from './repository';
import { LocalAudit } from './local-audit';

const exec = promisify(execFile);
let base: string;
let repo: string;
let recovery: string;
let broker: RepositoryBroker;
beforeEach(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), 'sand-repository-test-'));
  repo = path.join(base, 'repo'); recovery = path.join(base, 'recovery');
  await mkdir(repo); await writeFile(path.join(repo, 'hello.ts'), 'export const message = "hello";\n');
  broker = new RepositoryBroker(recovery); await broker.grant(repo);
});
afterEach(async () => { if (!path.resolve(base).startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(base).startsWith('sand-repository-test-')) throw new Error('Unsafe cleanup'); await rm(base, { recursive: true, force: true }); });

describe('real repository authority', () => {
  it.each(['../secret', 'a/../../secret', '/etc/passwd', 'C:/secret', 'x:ads', '.git/config', '.env', '.env.local', '.ssh/key', 'x\\file', 'NUL.txt', 'a//b', 'a/./b', 'trailing.', 'file\u0000name'])('rejects unsafe path %s', input => expect(() => validateRelative(input)).toThrow());
  it('excludes protected files and blocks inline credentials, binary and oversized files', async () => {
    await writeFile(path.join(repo, '.env'), 'SECRET=test');
    await writeFile(path.join(repo, 'key.ts'), 'const key = "' + 'sk-proj-' + 'A'.repeat(30) + '";');
    await writeFile(path.join(repo, 'binary.bin'), Buffer.from([0, 1, 2]));
    await writeFile(path.join(repo, 'big.txt'), 'x'.repeat(1048577));
    expect((await broker.list()).files).not.toContain('.env');
    await expect(broker.read('key.ts')).rejects.toMatchObject({ code: 'SECRET_BLOCKED' });
    await expect(broker.read('binary.bin')).rejects.toMatchObject({ code: 'FILE_LIMIT' });
    await expect(broker.read('big.txt')).rejects.toMatchObject({ code: 'FILE_LIMIT' });
  });
  it('rejects junction traversal and hard-linked files', async () => {
    const outside = path.join(base, 'outside'); await mkdir(outside); await writeFile(path.join(outside, 'private.txt'), 'private');
    await symlink(outside, path.join(repo, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(broker.read('linked/private.txt')).rejects.toMatchObject({ code: 'PATH_DENIED' });
    await link(path.join(outside, 'private.txt'), path.join(repo, 'hard.txt'));
    await expect(broker.read('hard.txt')).rejects.toMatchObject({ code: 'FILE_LIMIT' });
    expect((await broker.list()).files).not.toContain('linked/private.txt');
  });
  it('saves real content, retains recovery copy, and deduplicates same operation', async () => {
    const before = await broker.read('hello.ts');
    const input = { repositoryId: before.repositoryId, path: before.path, content: 'export const message = "saved";\n', expectedHash: before.hash, operationId: randomUUID() };
    const [first, second] = await Promise.all([broker.save(input), broker.save(input)]);
    expect(first.hash).toBe(second.hash); expect(await readFile(path.join(repo, 'hello.ts'), 'utf8')).toBe(input.content);
    const backups = (await readdir(recovery)).filter(file => file.endsWith('.backup'));
    expect(backups).toHaveLength(1); expect(await readFile(path.join(recovery, backups[0]!), 'utf8')).toBe(before.content);
    await expect(broker.save({ ...input, content: 'different' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
  it('preserves external changes on optimistic save conflict', async () => {
    const before = await broker.read('hello.ts'); await writeFile(path.join(repo, 'hello.ts'), 'external change');
    await expect(broker.save({ repositoryId: before.repositoryId, path: before.path, content: 'mine', expectedHash: before.hash, operationId: randomUUID() })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await readFile(path.join(repo, 'hello.ts'), 'utf8')).toBe('external change');
  });
  it('blocks a save tied to an old grant even if new repository has identical path and hash', async () => {
    const before = await broker.read('hello.ts'); const second = path.join(base, 'second'); await mkdir(second); await writeFile(path.join(second, 'hello.ts'), before.content);
    const grant = broker.grant(second);
    const save = broker.save({ repositoryId: before.repositoryId, path: before.path, content: 'wrong repository', expectedHash: before.hash, operationId: randomUUID() });
    await grant; await expect(save).rejects.toMatchObject({ code: 'STALE_REPOSITORY' });
    expect(await readFile(path.join(second, 'hello.ts'), 'utf8')).toBe(before.content);
    expect(await readFile(path.join(repo, 'hello.ts'), 'utf8')).toBe(before.content);
  });
  it('reads genuine Git status and diff without running configured helpers', async () => {
    await exec('git', ['init', repo], { windowsHide: true });
    await exec('git', ['-C', repo, 'add', '--', 'hello.ts'], { windowsHide: true });
    await exec('git', ['-C', repo, '-c', 'user.name=SAND Test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'initial'], { windowsHide: true });
    await exec('git', ['-C', repo, 'config', 'core.fsmonitor', 'SAND_MUST_NOT_EXECUTE'], { windowsHide: true });
    await exec('git', ['-C', repo, 'config', 'diff.external', 'SAND_MUST_NOT_EXECUTE'], { windowsHide: true });
    await writeFile(path.join(repo, 'hello.ts'), 'export const message = "changed";\n');
    expect((await broker.status()).entries).toContainEqual({ status: ' M', path: 'hello.ts' });
    expect(await broker.diff('hello.ts')).toContain('+export const message = "changed";');
    const subdir = path.join(repo, 'subdir'); await mkdir(subdir); await broker.grant(subdir);
    await expect(broker.status()).rejects.toMatchObject({ code: 'GIT_ROOT_REQUIRED' });
  });
  it('does not classify normal source as a secret and recognizes canaries', () => {
    expect(containsSecret('export function hello() { return "hello"; }')).toBe(false);
    expect(containsSecret('github_pat_' + 'A'.repeat(35))).toBe(true);
  });
});
describe('local audit', () => {
  it('serializes concurrent records, verifies reopen and detects tampering', async () => {
    const file = path.join(base, 'audit', 'ledger.jsonl'); const audit = new LocalAudit(file); await audit.initialize();
    await Promise.all(Array.from({ length: 10 }, (_, index) => audit.append({ action: 'read', inputHash: digest(String(index)) })));
    const reopened = new LocalAudit(file); await reopened.initialize(); await reopened.append({ action: 'write' });
    const lines = (await readFile(file, 'utf8')).trim().split('\n'); expect(lines).toHaveLength(11);
    const changed = JSON.parse(lines[3]!) as Record<string, unknown>; changed.event = { action: 'forged' }; lines[3] = JSON.stringify(changed);
    await writeFile(file, lines.join('\n') + '\n'); await expect(new LocalAudit(file).initialize()).rejects.toThrow('integrity');
  });
});

