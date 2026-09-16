import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { _electron as electron } from '@playwright/test';
const { stdout } = await promisify(execFile)(
  process.execPath,
  ['node_modules/tsx/dist/cli.mjs', 'services/tools-demo/main.ts'],
  { windowsHide: true, timeout: 300000, maxBuffer: 1000000 },
);
process.stdout.write(stdout);
const summary = stdout
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))
  .find((row) => row.event === 'demo.completed');
if (!summary) throw new Error('The real demo did not complete; no sample fallback.');
const directory = await realpath(summary.directory),
  root = await realpath('.runtime');
if (!directory.startsWith(root + path.sep)) throw new Error('Unexpected demo path');
const app = await electron.launch({
  args: ['.'],
  env: {
    ...process.env,
    SAND_E2E: '1',
    SAND_TEST_USER_DATA: directory,
    OPENAI_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    GEMINI_API_KEY: '',
    OPENROUTER_API_KEY: '',
    SAND_OIDC_ISSUER: '',
    SAND_API_TOKEN: '',
  },
});
const page = await app.firstWindow();
await page
  .locator('.studio-library .studio-list-item')
  .filter({ hasText: 'Hoàn tất' })
  .first()
  .click();
await page.getByRole('button', { name: 'Chọn bước Báo cáo cuối', exact: true }).click();
console.log(
  'SAND demo is open. This profile contains the real generated-demo run. Close the app to end this command.',
);
await new Promise((resolve) => app.on('close', resolve));
