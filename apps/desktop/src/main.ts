import { app, BrowserWindow, dialog, ipcMain, protocol, session } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { RepositoryBroker, RepositoryError, digest } from './repository';
import { LocalAudit } from './local-audit';
import type { Result } from './shared';

protocol.registerSchemesAsPrivileged([{ scheme: 'sand', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } }]);
const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; child-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
let window: BrowserWindow;
let broker: RepositoryBroker;
let audit: LocalAudit;
const relative = z.string().min(1).max(1000);
const uuid = z.string().uuid();
function trusted(event: IpcMainInvokeEvent): boolean { const frame = event.senderFrame; if (!frame) return false; const url = new URL(frame.url); return event.sender === window.webContents && frame === window.webContents.mainFrame && url.protocol === 'sand:' && url.hostname === 'app' && !url.port && !url.username && !url.password; }
function command<T>(name: string, schema: z.ZodType<T>, fn: (input: T) => Promise<unknown>): void {
  ipcMain.handle(name, async (event, raw): Promise<Result<unknown>> => {
    if (!trusted(event)) return { ok: false, error: { code: 'IPC_DENIED', message: 'This frame has no desktop capability.' } };
    const parsed = schema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'The command arguments are invalid.' } };
    try {
      await audit.append({ actor: 'local-user', tool: name, action: 'requested', inputHash: digest(JSON.stringify(raw ?? null)), result: 'pending' });
      const value = await fn(parsed.data);
      await audit.append({ actor: 'local-user', tool: name, action: 'finished', outputHash: digest(JSON.stringify(value ?? null)), result: 'success' });
      return { ok: true, value };
    } catch (error) {
      const code = error instanceof RepositoryError ? error.code : 'UNAVAILABLE';
      await audit.append({ actor: 'local-user', tool: name, action: 'finished', result: 'error', errorCode: code }).catch(() => undefined);
      return { ok: false, error: { code, message: error instanceof RepositoryError ? error.message : 'The operation is unavailable. Check local service configuration or the recovery ledger.' } };
    }
  });
}
function apiBase(): URL {
  const base = new URL(process.env.SAND_API_URL || 'http://127.0.0.1:4310');
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new RepositoryError('CONFIGURATION', 'This development preview only connects to a configured 127.0.0.1 control plane.');
  return base;
}
async function api(route: string, method = 'GET', body?: unknown, operationId?: string): Promise<Record<string, unknown>> {
  const token = process.env.SAND_API_TOKEN;
  if (!token) throw new RepositoryError('CONTROL_UNAVAILABLE', 'Set SAND_API_TOKEN in the desktop process and start the local control plane. Credentials never enter this renderer.');
  let response: Response;
  try { response = await fetch(new URL(route, apiBase()), { method, redirect: 'error', signal: AbortSignal.timeout(6000), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(operationId ? { 'Idempotency-Key': operationId } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); }
  catch { throw new RepositoryError('CONTROL_UNAVAILABLE', 'Control plane is unreachable. Start PostgreSQL, Temporal, and the local API, then reconnect.'); }
  if (!response.ok) throw new RepositoryError(`CONTROL_${response.status}`, response.status === 401 ? 'Control-plane authentication failed. Check the desktop process token.' : `Control plane returned HTTP ${response.status}. Check service health and permissions.`);
  if (Number(response.headers.get('content-length') || 0) > 2 * 1024 * 1024) throw new RepositoryError('OUTPUT_LIMIT', 'Control-plane response exceeds the desktop limit.');
  const reader = response.body?.getReader(); let length = 0; const chunks: Uint8Array[] = [];
  if (!reader) throw new RepositoryError('CONTROL_UNAVAILABLE', 'Control plane returned no response.');
  while (true) { const item = await reader.read(); if (item.done) break; length += item.value.length; if (length > 2 * 1024 * 1024) { await reader.cancel(); throw new RepositoryError('OUTPUT_LIMIT', 'Control-plane response exceeds the desktop limit.'); } chunks.push(item.value); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}
function registerCommands(): void {
  const empty = z.undefined();
  command('repository:open', empty, async () => {
    const testRoot = !app.isPackaged && process.env.SAND_E2E === '1' ? process.env.SAND_TEST_REPOSITORY : undefined;
    const selection = testRoot ? { canceled: false, filePaths: [testRoot] } : await dialog.showOpenDialog(window, { title: 'Open a repository in SAND', properties: ['openDirectory'] });
    return selection.canceled || !selection.filePaths[0] ? null : broker.grant(selection.filePaths[0]);
  });
  command('repository:list', empty, () => broker.list());
  command('repository:read', relative, input => broker.read(input));
  command('repository:save', z.object({ repositoryId: uuid, path: relative, content: z.string().max(1048576), expectedHash: z.string().regex(/^[a-f0-9]{64}$/), operationId: uuid }).strict(), input => broker.save(input));
  command('repository:status', empty, () => broker.status());
  command('repository:diff', relative, input => broker.diff(input));
  command('control:overview', empty, () => api('/v1/capabilities'));
  command('control:projects', empty, async () => (await api('/v1/projects')).projects);
  command('control:runs', empty, async () => (await api('/v1/runs')).runs);
  command('control:create', z.object({ projectId: uuid, operationId: uuid }).strict(), async input => (await api('/v1/runs', 'POST', { projectId: input.projectId, kind: 'registry.refresh' }, input.operationId)).run);
  command('control:events', z.object({ runId: uuid, after: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict(), async input => (await api(`/v1/runs/${input.runId}/events?after=${input.after}&limit=100`)).events);
  command('control:cancel', z.object({ runId: uuid, operationId: uuid }).strict(), async input => (await api(`/v1/runs/${input.runId}/cancel`, 'POST', {}, input.operationId)).run);
  command('control:models', empty, async () => (await api('/v1/models')).models);
  command('control:verify', empty, () => api('/v1/audit/verify'));
}

async function start(): Promise<void> {
  const dataRoot = !app.isPackaged && process.env.SAND_E2E === '1' && process.env.SAND_TEST_USER_DATA ? process.env.SAND_TEST_USER_DATA : app.getPath('userData');
  broker = new RepositoryBroker(path.join(dataRoot, 'recovery'));
  audit = new LocalAudit(path.join(dataRoot, 'audit', 'desktop.jsonl'));
  await audit.initialize();
  const rendererRoot = path.resolve(app.getAppPath(), 'dist/renderer');
  protocol.handle('sand', async request => {
    const url = new URL(request.url);
    if (url.hostname !== 'app' || request.method !== 'GET') return new Response('Denied', { status: 403 });
    let relativePath: string;
    try { relativePath = decodeURIComponent(url.pathname); } catch { return new Response('Invalid path', { status: 400 }); }
    if (relativePath.includes('..') || relativePath.includes('\\') || relativePath.includes('\0')) return new Response('Denied', { status: 403 });
    const target = path.resolve(rendererRoot, '.' + (relativePath === '/' ? '/index.html' : relativePath));
    if (!target.startsWith(rendererRoot + path.sep)) return new Response('Denied', { status: 403 });
    const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.woff2': 'font/woff2' };
    try { return new Response(await readFile(target), { headers: { 'Content-Type': mime[path.extname(target)] || 'application/octet-stream', 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' } }); }
    catch { return new Response('Not found', { status: 404 }); }
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('sand://app/') && !details.url.startsWith('devtools://') }));
  session.defaultSession.on('will-download', event => event.preventDefault());
  window = new BrowserWindow({ width: 1450, height: 950, minWidth: 1000, minHeight: 700, title: 'SAND', backgroundColor: '#f4f2ec', autoHideMenuBar: true, webPreferences: { preload: path.join(app.getAppPath(), 'dist/desktop/preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, spellcheck: false, devTools: !app.isPackaged } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  registerCommands();
  await window.loadURL('sand://app/');
}
if (!app.isPackaged && process.env.SAND_E2E === '1' && process.env.SAND_TEST_USER_DATA) app.setPath('userData', process.env.SAND_TEST_USER_DATA);
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.exit(0);
app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
app.whenReady().then(() => singleInstance ? start() : undefined).catch(() => { dialog.showErrorBox('SAND cannot start', 'Local startup or audit verification failed. Preserve your recovery folder and check service configuration.'); app.exit(1); });
app.on('window-all-closed', () => app.quit());


