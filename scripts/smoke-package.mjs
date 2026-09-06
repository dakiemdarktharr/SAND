import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir, writeFile, readFile, stat} from 'node:fs/promises';
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
  await expect(page.getByRole('heading', {name:/Build with/})).toBeVisible();
  const launchToVisibleMs = Math.round(performance.now() - started);
  const security = await app.evaluate(({app, BrowserWindow}) => {
    const prefs = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return {packaged:app.isPackaged, sandbox:prefs.sandbox, contextIsolation:prefs.contextIsolation, nodeIntegration:prefs.nodeIntegration};
  });
  assert.deepEqual(security,{packaged:true,sandbox:true,contextIsolation:true,nodeIntegration:false});
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  assert.deepEqual(errors, []);
  await mkdir('artifacts/local', {recursive:true});
  await page.screenshot({path:'artifacts/local/packaged-preview.png'});
  const evidence = {at:new Date().toISOString(),platform:process.platform,arch:process.arch,executablePath,security,launchToVisibleMs,archiveFiles:entries.length,archiveBytes:(await stat(archive)).size,archiveSha256:createHash('sha256').update(await readFile(archive)).digest('hex'),result:'passed',installerLifecycle:'not tested',productionSigning:'not configured'};
  await writeFile('artifacts/local/package-smoke.json', JSON.stringify(evidence,null,2)+'\n');
  console.log(JSON.stringify(evidence,null,2));
} finally {
  await app.close();
}
