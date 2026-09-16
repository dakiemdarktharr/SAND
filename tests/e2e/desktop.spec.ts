import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
let application: ElectronApplication;
let page: Page;
let temporary: string;
let repository: string;

test.beforeEach(async ({ browserName: _browserName }, testInfo) => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'sand-electron-e2e-'));
  repository = path.join(temporary, 'engineering-notes'); await mkdir(repository);
  await writeFile(path.join(repository, 'hello.ts'), 'export const greeting = "hello from SAND";\n');
  await writeFile(path.join(repository, 'README.md'), '# Engineering notes\n\nA real repository opened by the SAND desktop test.\n');
  await writeFile(path.join(repository, '.env'), 'BLOCKED_FILE=yes\n');
  await exec('git', ['init', repository], { windowsHide: true });
  await exec('git', ['-C', repository, 'add', '--', 'hello.ts', 'README.md'], { windowsHide: true });
  await exec('git', ['-C', repository, '-c', 'user.name=SAND E2E', '-c', 'user.email=sand@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'test fixture'], { windowsHide: true });
  const started = performance.now();
  application = await electron.launch({ args: ['.'], env: { ...process.env, SAND_E2E: '1', SAND_TEST_REPOSITORY: repository, SAND_TEST_USER_DATA: path.join(temporary, 'user-data'), SAND_API_TOKEN: '', SAND_API_URL: 'http://127.0.0.1:4310' } });
  page = await application.firstWindow();
  await page.getByRole('button', {name:'Mở IDE',exact:true}).click();
  await expect(page.getByRole('heading', { name: /Build with/ })).toBeVisible();
  await testInfo.attach('startup-measurement.json', { body: JSON.stringify({ measuredAt: new Date().toISOString(), os: process.platform, coldLaunchToVisibleHeadingMs: Math.round(performance.now() - started), sample: 1, productionBenchmark: false }), contentType: 'application/json' });
});

test.afterEach(async () => {
  if (application) await application.close();
  if (!path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(temporary).startsWith('sand-electron-e2e-')) throw new Error('Unsafe cleanup');
  await rm(temporary, { recursive: true, force: true, maxRetries: 4, retryDelay: 500 });
});

test('truthful unavailable state, Node isolation, network denial, theme and command palette', async () => {
  await expect(page.getByText('Control plane unavailable', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start discovery' })).toBeDisabled();
  expect(await page.evaluate(() => ({ require: typeof (window as unknown as { require?: unknown }).require, process: typeof (window as unknown as { process?: unknown }).process, keys: Object.keys(window.sand).sort() }))).toEqual({ require: 'undefined', process: 'undefined', keys: ['control', 'repository', 'studio'] });
  const preferences = await application.evaluate(({ BrowserWindow }) => (BrowserWindow.getAllWindows()[0]!.webContents as unknown as { getLastWebPreferences(): { contextIsolation: boolean; sandbox: boolean; nodeIntegration: boolean } }).getLastWebPreferences());
  expect(preferences.contextIsolation).toBe(true); expect(preferences.sandbox).toBe(true); expect(preferences.nodeIntegration).toBe(false);
  expect(await page.evaluate(() => fetch('https://example.com').then(() => 'allowed', () => 'blocked'))).toBe('blocked');
  expect(await page.evaluate(() => window.sand.repository.read('../outside.txt'))).toMatchObject({ ok: false, error: { code: 'PATH_DENIED' } });
  await mkdir('artifacts/local', { recursive: true }); await page.screenshot({ path: 'artifacts/local/workbench.png' });
  await page.getByRole('button', { name: 'Use dark theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.keyboard.press('Control+k'); await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Search commands', exact: true }).fill('model registry');
  await page.keyboard.press('Enter'); await expect(page.getByRole('heading', { name: 'Your models. Their sources.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No models have been discovered' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh registry', exact: true })).toBeDisabled();
});

test('opens a real repository, edits with Monaco, saves and reads real Git diff', async () => {
  await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Repository files' })).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: '.env' })).toHaveCount(0);
  await page.getByRole('listitem').filter({ hasText: 'hello.ts' }).click();
  const editor = page.getByRole('textbox', { name: 'Editor content hello.ts' });
  await expect(editor).toBeVisible(); await editor.focus(); await page.keyboard.press('Control+a'); await page.keyboard.insertText('export const greeting = "verified save";\n');
  await expect(page.locator('.editor-path-right')).toContainText('Unsaved changes');
  await page.keyboard.press('Control+s');
  await expect(page.getByText('Saved · recovery copy retained', { exact: true })).toBeVisible();
  expect(await readFile(path.join(repository, 'hello.ts'), 'utf8')).toBe('export const greeting = "verified save";\n');
  const backups = (await readdir(path.join(temporary, 'user-data', 'recovery'))).filter(file => file.endsWith('.backup'));
  expect(backups).toHaveLength(1);
  await page.screenshot({ path: 'artifacts/local/workbench-editor.png' });
  await page.getByRole('button', { name: 'Source control', exact: true }).click();
  await page.locator('.file-row').filter({ hasText: 'hello.ts' }).click();
  await expect(page.locator('.diff-view')).toContainText('+export const greeting = "verified save";');
});

test('retains dirty edits on external conflict and on tab close', async () => {
  await page.getByRole('button', { name: 'Open a repository', exact: true }).click();
  await page.getByRole('listitem').filter({ hasText: 'hello.ts' }).click();
  const editor = page.getByRole('textbox', { name: 'Editor content hello.ts' });
  await expect(editor).toBeVisible(); await editor.focus(); await page.keyboard.press('Control+a'); await page.keyboard.insertText('export const greeting = "my unsaved edit";\n');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  await writeFile(path.join(repository, 'hello.ts'), 'external edit\n');
  await page.keyboard.press('Control+s'); await expect(page.locator('.error-banner[role=alert]')).toContainText('changed on disk');
  expect(await readFile(path.join(repository, 'hello.ts'), 'utf8')).toBe('external edit\n');
  await expect(page.locator('.editor-path-right')).toContainText('Unsaved changes');
  await page.getByRole('button', { name: 'Close hello.ts' }).click();
  await expect(page.locator('.error-banner[role=alert]')).toContainText('Save this file before closing');
  await expect(page.getByRole('tab', { name: 'hello.ts' })).toBeVisible();
});



