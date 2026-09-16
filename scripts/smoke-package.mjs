import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {mkdir, mkdtemp, writeFile, readFile, stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {listPackage} from '@electron/asar';
import {_electron as electron, expect} from '@playwright/test';

assert.equal(process.platform, 'win32', 'This smoke checks the Windows preview; macOS needs its own runner.');
const executablePath = path.resolve('release/win-unpacked/SAND Preview.exe');
const archive = path.resolve('release/win-unpacked/resources/app.asar');
const entries = listPackage(archive);
assert(!entries.some(entry => /[/\\]node_modules[/\\]/u.test(entry)), 'Desktop archive must not contain backend dependency trees');
const started = performance.now();
const app = await electron.launch({executablePath, env:{...process.env,SAND_API_TOKEN:''}});
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await expect(page.getByRole('heading', {name:'Thiết kế đội ngũ AI của bạn'})).toBeVisible();
  const launchToVisibleMs = Math.round(performance.now() - started);
  const security = await app.evaluate(({app, BrowserWindow}) => {
    const prefs = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return {packaged:app.isPackaged, sandbox:prefs.sandbox, contextIsolation:prefs.contextIsolation, nodeIntegration:prefs.nodeIntegration};
  });
  assert.deepEqual(security,{packaged:true,sandbox:true,contextIsolation:true,nodeIntegration:false});
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  assert.deepEqual(errors, []);
  const vault=await page.evaluate(()=>window.sand.studio.security());
  assert(vault.ok&&vault.value.vaultAvailable,'Packaged Windows OS vault must be available');
  await mkdir('.runtime',{recursive:true});const temp=await mkdtemp(path.resolve('.runtime/package-mcp-'));
  const configFile=path.join(temp,'server.json');
  await writeFile(configFile,JSON.stringify({id:'package-utility',transport:'stdio',command:process.execPath,args:['--import',pathToFileURL(path.resolve('node_modules/tsx/dist/loader.mjs')).href,path.resolve('services/mcp-utility/main.ts')]}));
  // Test-only chooser/consent substitution; the packaged MCP client and subprocess are real.
  await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});},configFile);
  const connection=await page.evaluate(()=>window.sand.studio.connectMcp());assert(connection.ok&&connection.value?.tools.length===1,'Packaged MCP discovery failed: '+JSON.stringify(connection));
  assert((await page.evaluate(()=>window.sand.studio.disconnectMcp('package-utility'))).ok);

  await mkdir('artifacts/local', {recursive:true});
  await page.screenshot({path:'artifacts/local/packaged-preview.png'});
  const evidence = {at:new Date().toISOString(),platform:process.platform,arch:process.arch,executablePath,security,vaultAvailable:true,mcpStdioDiscovery:'actual subprocess',launchToVisibleMs,archiveFiles:entries.length,archiveBytes:(await stat(archive)).size,archiveSha256:createHash('sha256').update(await readFile(archive)).digest('hex'),result:'passed',installerLifecycle:'not tested',productionSigning:'not configured'};
  await writeFile('artifacts/local/package-smoke.json', JSON.stringify(evidence,null,2)+'\n');
  console.log(JSON.stringify(evidence,null,2));
} finally {
  await app.close();
}
