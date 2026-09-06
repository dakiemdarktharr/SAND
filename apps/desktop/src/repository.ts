import { constants } from 'node:fs';
import { mkdir, readdir, realpath, lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DocumentFile, GitStatus, Repository } from './shared';

const exec = promisify(execFile);
const MAX_FILE = 1024 * 1024;
const secretName = /^(\.env(?:\..*)?|\.npmrc|\.pypirc|credentials(?:\..*)?|id_rsa|id_ed25519|.*\.(?:pem|key|p12|pfx))$/i;
const deniedDirs = new Set(['.git', 'node_modules', '.sand', '.ssh', '.aws', '.azure', '.gnupg', '.secrets']);
export const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export class RepositoryError extends Error { constructor(public code: string, message: string) { super(message); } }
export function containsSecret(text: string): boolean {
  return /(?:-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b|(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[=:]\s*["'](?!\$\{|process\.|["'])[^"'\r\n]{12,}["'])/i.test(text);
}
export function validateRelative(input: string): string {
  // eslint-disable-next-line no-control-regex -- Reject C0 control characters in filesystem paths.
  if (!input || input.length > 1000 || /[\x00-\x1f\\:]/.test(input) || path.isAbsolute(input)) throw new RepositoryError('PATH_DENIED', 'Only safe repository-relative paths are allowed.');
  const parts = input.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p) || deniedDirs.has(p.toLowerCase()) || secretName.test(p))) throw new RepositoryError('PATH_DENIED', 'Metadata, secret files, and unsafe paths are blocked.');
  return input;
}
export class RepositoryBroker {
  private root: string | null = null;
  private repositoryId = randomUUID();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly recoveryDirectory: string) {}
  private serial<T>(fn: () => Promise<T>): Promise<T> { const result = this.queue.then(fn, fn); this.queue = result.catch(() => undefined); return result; }
  async grant(selected: string): Promise<Repository> {
    return this.serial(async () => {
    const info = await lstat(selected);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new RepositoryError('PATH_DENIED', 'Choose a real local directory, not a link.');
    const canonical = await realpath(selected);
    if (canonical.startsWith('\\\\')) throw new RepositoryError('PATH_DENIED', 'Network workspaces are unavailable in this preview.');
    this.root = canonical; this.repositoryId = randomUUID();
    await mkdir(this.recoveryDirectory, { recursive: true, mode: 0o700 });
    return this.list();
    });
  }
  private requireRoot(): string { if (!this.root) throw new RepositoryError('NO_REPOSITORY', 'Open a repository first.'); return this.root; }
  private async checked(relative: string): Promise<string> {
    validateRelative(relative);
    const root = this.requireRoot();
    const rootInfo = await lstat(root);
    if (rootInfo.isSymbolicLink() || await realpath(root) !== root) throw new RepositoryError('PATH_DENIED', 'The repository root changed. Reopen it.');
    let candidate = root;
    for (const segment of relative.split('/')) {
      candidate = path.join(candidate, segment);
      const info = await lstat(candidate);
      if (info.isSymbolicLink()) throw new RepositoryError('PATH_DENIED', 'Links and junctions cannot be followed.');
    }
    const canonical = await realpath(candidate);
    if (canonical !== candidate || !canonical.startsWith(root + path.sep)) throw new RepositoryError('PATH_DENIED', 'The target is outside the granted repository.');
    return candidate;
  }
  async list(): Promise<Repository> {
    const root = this.requireRoot(); const files: string[] = []; let truncated = false; let visited = 0;
    const walk = async (dir: string, prefix: string, depth: number) => {
      if (depth > 12 || visited > 15000 || files.length >= 2000) { truncated = true; return; }
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (visited >= 15000 || files.length >= 2000) { truncated = true; break; }
        visited++; const relative = prefix + entry.name;
        try { validateRelative(relative); } catch { continue; }
        if (entry.isSymbolicLink()) continue;
        const checked = await this.checked(relative).catch(() => null);
        if (!checked) continue;
        if (entry.isDirectory()) await walk(checked, relative + '/', depth + 1);
        else if (entry.isFile() && files.length < 2000) files.push(relative);
      }
    };
    await walk(root, '', 0);
    return { id: this.repositoryId, name: path.basename(root), files, truncated };
  }
  async read(relative: string): Promise<DocumentFile> {
    const repositoryId = this.repositoryId;
    const target = await this.checked(relative);
    const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_FILE) throw new RepositoryError('FILE_LIMIT', 'Only text files up to 1 MiB are supported.');
      const bytes = await handle.readFile();
      if (bytes.includes(0) || bytes.length > MAX_FILE) throw new RepositoryError('FILE_LIMIT', 'Binary or oversized files cannot be opened.');
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (containsSecret(content)) throw new RepositoryError('SECRET_BLOCKED', 'This file contains a possible credential. Remove it using a trusted external editor.');
      await this.checked(relative);
      if (repositoryId !== this.repositoryId) throw new RepositoryError('STALE_REPOSITORY', 'Repository selection changed. Reopen the file.');
      return { repositoryId, path: relative, content, hash: digest(bytes) };
    } finally { await handle.close(); }
  }
  async save(input: { repositoryId: string; path: string; content: string; expectedHash: string; operationId: string }): Promise<DocumentFile> {
    return this.serial(async () => {
      if (input.repositoryId !== this.repositoryId) throw new RepositoryError('STALE_REPOSITORY', 'This file belongs to a previous repository selection. Reopen it.');
      if (!/^[a-f0-9-]{36}$/i.test(input.operationId) || !/^[a-f0-9]{64}$/.test(input.expectedHash) || Buffer.byteLength(input.content) > MAX_FILE) throw new RepositoryError('INVALID_ARGUMENT', 'Invalid save request.');
      if (containsSecret(input.content)) throw new RepositoryError('SECRET_BLOCKED', 'Saving probable credentials through this broker is blocked.');
      const scope = digest(this.requireRoot());
      const receiptPath = path.join(this.recoveryDirectory, `${scope}-${input.operationId}.json`);
      const intentHash = digest(JSON.stringify(input));
      const savedReceipt = await readFile(receiptPath, 'utf8').catch(() => null);
      if (savedReceipt) {
        const receipt = JSON.parse(savedReceipt) as { intentHash: string; outputHash: string };
        if (receipt.intentHash !== intentHash) throw new RepositoryError('IDEMPOTENCY_CONFLICT', 'This save key belongs to a different operation.');
        const current = await this.read(input.path);
        if (current.hash !== receipt.outputHash) throw new RepositoryError('CONFLICT', 'The file changed after this save. Reload to reconcile.');
        return current;
      }
      const current = await this.read(input.path);
      if (current.hash !== input.expectedHash) throw new RepositoryError('CONFLICT', 'The file changed on disk. Your edits are retained; reload or copy them before retrying.');
      const target = await this.checked(input.path);
      const backupPath = path.join(this.recoveryDirectory, `${scope}-${input.operationId}.backup`);
      const backup = await open(backupPath, 'wx', 0o600);
      try { await backup.writeFile(await readFile(target)); await backup.sync(); } finally { await backup.close(); }
      const temp = `${target}.sand-${input.operationId}.tmp`;
      const outputHash = digest(input.content);
      // Durable intent and recoverable backup exist before replacement. The same key can reconcile a crash.
      const intent = await open(receiptPath, 'wx', 0o600);
      try { await intent.writeFile(JSON.stringify({ intentHash, outputHash, path: input.path, backup: path.basename(backupPath), at: new Date().toISOString() })); await intent.sync(); } finally { await intent.close(); }
      try {
        const tmp = await open(temp, 'wx', (await lstat(target)).mode);
        try { await tmp.writeFile(input.content); await tmp.sync(); } finally { await tmp.close(); }
        if ((await this.read(input.path)).hash !== input.expectedHash) throw new RepositoryError('CONFLICT', 'The file changed during save. Original and recovery copy are preserved.');
        await this.checked(input.path);
        await rename(temp, target);
      } catch (error) { await unlink(temp).catch(() => undefined); throw error; }
      return { repositoryId: this.repositoryId, path: input.path, content: input.content, hash: outputHash };
    });
  }
  private async git(args: string[]): Promise<string> {
    const root = this.requireRoot();
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LANG: 'C.UTF-8' };
    try {
      const top = await exec('git', ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', root, 'rev-parse', '--show-toplevel'], { env, timeout: 8000, maxBuffer: MAX_FILE, windowsHide: true, encoding: 'utf8' });
      if (await realpath(top.stdout.trim()) !== root) throw new RepositoryError('GIT_ROOT_REQUIRED', 'Select the Git repository root to inspect changes. Ancestor repositories are not granted.');
      const result = await exec('git', ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'diff.external=', '-c', 'core.untrackedCache=false', '-C', root, ...args], { env, timeout: 8000, maxBuffer: MAX_FILE, windowsHide: true, encoding: 'utf8' });
      if (containsSecret(result.stdout)) throw new RepositoryError('SECRET_BLOCKED', 'Git output contains a possible credential and was blocked.');
      return result.stdout;
    } catch (error) { if (error instanceof RepositoryError) throw error; throw new RepositoryError('GIT_UNAVAILABLE', 'Git could not read this repository. Check Git installation and repository validity.'); }
  }
  async status(): Promise<GitStatus> {
    const status = await this.git(['status', '--porcelain=v1', '-z', '--untracked-files=normal']);
    const branch = (await this.git(['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => 'detached')).trim();
    const records = status.split('\0'); const entries: GitStatus['entries'] = [];
    for (let i = 0; i < records.length; i++) { const record = records[i]; if (!record) continue; const code = record.slice(0, 2); const relative = record.slice(3); if (/[RC]/.test(code)) i++; try { validateRelative(relative); entries.push({ status: code, path: relative }); } catch { /* Secret paths are not returned. */ } }
    return { entries, branch };
  }
  async diff(relative: string): Promise<string> { await this.checked(relative); return this.git(['diff', '--no-ext-diff', '--no-textconv', '--', relative]); }
}



