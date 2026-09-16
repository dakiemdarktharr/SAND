import { app, BrowserWindow, dialog, ipcMain, protocol, session, safeStorage, shell } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { readFile, writeFile, mkdir, mkdtemp, lstat } from 'node:fs/promises';
import { StudioRuntime, secretLike } from '../../../packages/studio/src/runtime';
import { TextInference } from '../../../packages/studio/src/inference';
import { definitionSchema, StudioError } from '../../../packages/studio/src/schema';
import path from 'node:path';
import { z } from 'zod';
import { RepositoryBroker, RepositoryError, digest } from './repository';
import { LocalAudit } from './local-audit';
import type { Result } from './shared';
import {DesktopTools} from './tools';
import {ToolJournal} from '../../../packages/tools/src/journal';
import {GovernedAgent} from '../../../packages/tools/src/agent';
import {mcpConfiguration} from '../../../packages/tools/src/mcp';
import {CredentialVault} from '../../../packages/identity/src/vault';
import {DesktopOidc} from '../../../packages/identity/src/oidc';
let toolHost:DesktopTools;
let toolJournal:ToolJournal;
let vault:CredentialVault;
let identity:DesktopOidc;
const credentialNames=['OPENAI_API_KEY','ANTHROPIC_API_KEY','GEMINI_API_KEY','OPENROUTER_API_KEY'] as const;
async function inferenceEnvironment(){const env={...process.env};if(await vault.available())for(const key of credentialNames){const stored=await vault.get(key);if(stored)env[key]=stored;}return env;}


protocol.registerSchemesAsPrivileged([{ scheme: 'sand', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } }]);
const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; child-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
let window: BrowserWindow;
let broker: RepositoryBroker;
let audit: LocalAudit;
let studio: StudioRuntime;
let inference: TextInference;
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
      const code = error instanceof RepositoryError || error instanceof StudioError ? error.code : 'UNAVAILABLE';
      await audit.append({ actor: 'local-user', tool: name, action: 'finished', result: 'error', errorCode: code }).catch(() => undefined);
      return { ok: false, error: { code, message: error instanceof RepositoryError || error instanceof StudioError ? error.message : 'The operation is unavailable. Check local service configuration or the recovery ledger.' } };
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
  command('studio:backup',empty,async()=>{
    const selected=await dialog.showOpenDialog(window,{title:'Chọn thư mục cha cho backup workflow (không gồm credential)',properties:['openDirectory']});const parent=selected.filePaths[0];if(selected.canceled||!parent)return null;
    const info=await lstat(parent);if(!info.isDirectory()||info.isSymbolicLink())throw new StudioError('BACKUP_PATH_DENIED','Chọn thư mục thật.');
    const directory=await mkdtemp(path.join(parent,'sand-backup-'));
    // Both synchronous snapshots run in one main-process turn: no new IPC/agent work interleaves.
    studio.backup(path.join(directory,'studio.sqlite'));toolJournal.backup(path.join(directory,'tools.sqlite'));
    const files=await Promise.all(['studio.sqlite','tools.sqlite'].map(async name=>({name,sha256:digest(await readFile(path.join(directory,name)))})));
    await writeFile(path.join(directory,'manifest.json'),JSON.stringify({schemaVersion:1,createdAt:new Date().toISOString(),files,excludes:['credentials','repository files','desktop IPC audit'],restore:'Close SAND. Restore both files together into a NEW userData directory. Preserve the original directory.'},null,2),{flag:'wx'});return directory;
  });
  command('studio:tools',empty,async()=>toolHost.catalog().map(({name,description,scope})=>({name,description,scope})));
  command('studio:approvals',uuid,async id=>{studio.get(id);return toolJournal.list(id);});
  command('studio:approveTool',z.object({runId:uuid,id:z.string().regex(/^[a-f0-9]{64}$/),approve:z.boolean()}).strict(),async value=>{
    const run=studio.get(value.runId),approval=toolJournal.list(value.runId).find(a=>a.id===value.id);
    if(!approval||!['running','waiting','paused'].includes(run.status)||!run.nodes.some(n=>n.id===approval.nodeId&&n.error==='AWAITING_TOOL_APPROVAL'))throw new StudioError('APPROVAL_NOT_PENDING','Run không còn chờ approval.');
    toolJournal.decide(value.id,value.approve);return studio.continueTool(value.runId,approval.nodeId,value.id,value.approve);
  });
  command('studio:security',empty,async()=>({vaultAvailable:await vault.available(),providers:Object.fromEntries(await Promise.all(credentialNames.map(async key=>[key,Boolean(process.env[key]||(await vault.available()?await vault.get(key):undefined))]))),identity:await identity.status().catch(()=>({configured:!!process.env.SAND_OIDC_ISSUER,signedIn:false,unavailable:true}))}));
  command('studio:storeEnvironmentKey',z.enum(credentialNames),async key=>{const value=process.env[key];if(!value)throw new StudioError('CREDENTIAL_UNAVAILABLE','Biến môi trường chưa được cấu hình trong desktop.');await vault.set(key,value);inference.configure(await inferenceEnvironment());return {stored:true,provider:key};});
  command('studio:removeStoredKey',z.enum(credentialNames),async key=>{await vault.set(key,undefined);inference.configure(await inferenceEnvironment());return {removed:true,environmentStillConfigured:Boolean(process.env[key])};});
  command('studio:login',empty,()=>identity.login());
  command('studio:logout',empty,()=>identity.logout());
  command('studio:connectMcp',empty,async()=>{
    const selection=await dialog.showOpenDialog(window,{title:'Chọn cấu hình MCP tin cậy',properties:['openFile'],filters:[{name:'MCP JSON',extensions:['json']} ]});
    const file=selection.filePaths[0];if(selection.canceled||!file)return null;
    const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size>16000)throw new StudioError('MCP_CONFIG_DENIED','Cấu hình MCP phải là file JSON nhỏ, không phải link.');
    const config=mcpConfiguration.parse(JSON.parse(await readFile(file,'utf8')));
    if(secretLike(JSON.stringify(config)))throw new StudioError('SECRET_DETECTED','Không đặt token trong MCP JSON.');
    const answer=await dialog.showMessageBox(window,{type:'warning',title:'Cấp quyền kết nối MCP',message:config.transport==='stdio'?'MCP local chạy với quyền tài khoản OS của bạn; đây không phải sandbox.':'Kết nối tới MCP HTTPS đã chọn.',detail:JSON.stringify(config,null,2)+'\nMỗi tool vẫn cần duyệt tham số. Server có thể trả nội dung không đáng tin cậy.',buttons:['Hủy','Kết nối server này'],defaultId:0,cancelId:0});
    if(answer.response!==1)return null;return toolHost.mcp.connect(config);
  });
  command('studio:disconnectMcp',z.string().regex(/^[a-z0-9_-]{1,30}$/),async id=>{await toolHost.mcp.disconnect(id);return {disconnected:true};});
  command('studio:definitions',empty,()=>Promise.resolve(studio.definitions()));
  command('studio:save',definitionSchema,async value=>studio.save(value));
  command('studio:discover',empty,()=>inference.discover());
  command('studio:runs',empty,async()=>studio.list());
  command('studio:get',uuid,async id=>studio.get(id));
  command('studio:start',z.object({definition:definitionSchema,input:z.string().min(1).max(16000),allowCloud:z.boolean(),key:uuid}).strict(),async value=>studio.start(value.definition,value.input,value.allowCloud,value.key));
  command('studio:command',z.object({id:uuid,action:z.enum(['pause','resume','cancel'])}).strict(),async value=>studio.command(value.id,value.action));
  command('studio:review',z.object({id:uuid,nodeId:z.string().max(40),approve:z.boolean()}).strict(),async value=>studio.review(value.id,value.nodeId,value.approve));
  command('studio:verify',uuid,async id=>studio.verify(id));
  command('studio:export',uuid,async id=>{
    const content=studio.artifact(id);
    const selection=await dialog.showSaveDialog(window,{title:'Xuất báo cáo hoàn tất',defaultPath:'sand-report-'+id.slice(0,8)+'.md',filters:[{name:'Markdown',extensions:['md']}]});
    if(selection.canceled||!selection.filePath)return null;
    // Exclusive creation avoids silently overwriting any existing user document.
    try { await writeFile(selection.filePath,content,{encoding:'utf8',flag:'wx'}); }
    catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new StudioError('EXPORT_EXISTS','File đã tồn tại. Chọn tên mới để giữ nguyên tài liệu cũ.');throw error;}
    return selection.filePath;
  });
  command('studio:importText',empty,async()=>{
    const selection=await dialog.showOpenDialog(window,{title:'Chọn tài liệu đầu vào',properties:['openFile'],filters:[{name:'Text / Markdown',extensions:['txt','md','csv']}]});
    const file=selection.filePaths[0];if(selection.canceled||!file)return null;
    const info=await lstat(file);
    if(!info.isFile()||info.isSymbolicLink()||info.size>64000||/^(\.env|credentials|id_rsa)/i.test(path.basename(file)))throw new StudioError('INPUT_DENIED','Chỉ nhập tài liệu nhỏ, không chứa credential hoặc symlink.');
    const text=await readFile(file,'utf8');
    if(text.length>16000||secretLike(text))throw new StudioError('INPUT_DENIED','Tài liệu quá 16.000 ký tự hoặc có nội dung dạng secret.');
    return {name:path.basename(file),text};
  });
  command('repository:open', empty, async () => {
    const testRoot = !app.isPackaged && process.env.SAND_E2E === '1' ? process.env.SAND_TEST_REPOSITORY : undefined;
    const selection = testRoot ? { canceled: false, filePaths: [testRoot] } : await dialog.showOpenDialog(window, { title: 'Open a repository in SAND', properties: ['openDirectory'] });
    if(selection.canceled||!selection.filePaths[0])return null;const repository=await broker.grant(selection.filePaths[0]);toolHost.repositoryId=repository.id;return repository;
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
  await mkdir(dataRoot,{recursive:true});
  vault=new CredentialVault(path.join(dataRoot,'credentials.enc'),{
    available:async()=>await safeStorage.isAsyncEncryptionAvailable()&&(process.platform!=='linux'||safeStorage.getSelectedStorageBackend()!=='basic_text'),
    encrypt:text=>safeStorage.encryptStringAsync(text),decrypt:async bytes=>(await safeStorage.decryptStringAsync(bytes)).result
  });
  identity=new DesktopOidc(vault,process.env.SAND_OIDC_ISSUER&&process.env.SAND_OIDC_CLIENT_ID?{issuer:process.env.SAND_OIDC_ISSUER,clientId:process.env.SAND_OIDC_CLIENT_ID,port:Number(process.env.SAND_OIDC_PORT??43827)}:undefined,url=>shell.openExternal(url));
  inference=new TextInference(await inferenceEnvironment());
  toolHost=new DesktopTools(broker);toolJournal=new ToolJournal(path.join(dataRoot,'tools.sqlite'));
  studio=new StudioRuntime(path.join(dataRoot,'studio.sqlite'),new GovernedAgent(inference,toolJournal,toolHost));
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
app.on('before-quit',()=>{studio?.close();void toolHost?.mcp.close();});
app.on('window-all-closed', () => app.quit());


