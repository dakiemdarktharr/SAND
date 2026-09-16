import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
let application: ElectronApplication | undefined;
let page: Page;
async function launch(directory: string, extra: Record<string, string> = {}) {
  application = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      SAND_E2E: '1',
      SAND_TEST_USER_DATA: directory,
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      GEMINI_API_KEY: '',
      OPENROUTER_API_KEY: '',
      SAND_API_TOKEN: '',
      SAND_API_URL: 'http://127.0.0.1:4310',
      ...extra,
    },
  });
  page = await application.firstWindow();
  await expect(page.getByRole('heading', { name: 'Thiết kế đội ngũ AI của bạn' })).toBeVisible();
}
test.afterEach(async () => {
  await application?.close();
  application = undefined;
});
test('Studio saves an editable graph and restores it across a desktop restart without inference', async () => {
  await mkdir('.runtime', { recursive: true });
  const directory = await mkdtemp(path.resolve('.runtime/studio-desktop-'));
  await launch(directory);
  await expect(page.getByRole('button', { name: 'Chạy workflow', exact: true })).toBeDisabled();
  await page
    .getByRole('textbox', { name: 'Tên workflow', exact: true })
    .fill('Museum review workflow');
  await page
    .getByRole('textbox', { name: 'Chỉ dẫn agent', exact: true })
    .fill('Summarize only the supplied exhibit notes.');
  await page.getByRole('button', { name: /^Lưu/ }).click();
  await expect(page.getByRole('status')).toContainText('Đã lưu phiên bản 1');
  await mkdir('artifacts/local', { recursive: true });
  await page.screenshot({ path: 'artifacts/local/workflow-studio.png' });
  await application!.close();
  application = undefined;
  await launch(directory);
  await expect(page.getByRole('textbox', { name: 'Tên workflow', exact: true })).toHaveValue(
    'Museum review workflow',
  );
  await expect(page.getByRole('textbox', { name: 'Chỉ dẫn agent', exact: true })).toHaveValue(
    'Summarize only the supplied exhibit notes.',
  );
  // Connecting an upstream node to its descendant creates a cycle: save/run must be disabled.
  await page.getByRole('checkbox', { name: 'Biên tập báo cáo', exact: true }).check();
  await expect(page.getByRole('button', { name: /^Lưu/ })).toBeDisabled();
  await expect(page.locator('.studio-validation')).toContainText('vòng lặp');
  expect(
    await page.evaluate(() => ({
      node: typeof (window as unknown as { require?: unknown }).require,
      keys: Object.keys(window.sand).sort(),
    })),
  ).toEqual({ node: 'undefined', keys: ['control', 'repository', 'studio'] });
  expect(
    await page.evaluate(() =>
      fetch('https://example.com').then(
        () => true,
        () => false,
      ),
    ),
  ).toBe(false);
});
test('live Ollama: two models, parallel agents, review, restart, approval and final artifact', async () => {
  test.skip(
    process.env.SAND_STUDIO_LIVE_TESTS !== '1',
    'Requires an actual Ollama server with two installed chat models; no mock fallback.',
  );
  test.setTimeout(600_000);
  await mkdir('.runtime', { recursive: true });
  const directory = await mkdtemp(path.resolve('.runtime/studio-live-desktop-'));
  await launch(directory);
  await page.getByRole('button', { name: 'Kết nối / tìm model', exact: true }).click();
  await expect(
    page.getByRole('button', { name: /Điền model cho các agent còn trống/ }),
  ).toBeEnabled({ timeout: 45_000 });
  const options = await page
    .getByRole('combobox', { name: 'Model của agent' })
    .locator('option')
    .allTextContents();
  expect(options.filter((s) => s.startsWith('ollama / ')).length).toBeGreaterThanOrEqual(2);
  await page.getByRole('button', { name: /Điền model cho các agent còn trống/ }).click();
  for (const name of ['Chuyên gia phân tích', 'Chuyên gia phản biện', 'Biên tập báo cáo']) {
    await page.getByRole('button', { name: 'Chọn bước ' + name, exact: true }).click();
    await page.getByRole('spinbutton', { name: 'Giới hạn output', exact: true }).fill('64');
    await page
      .getByRole('textbox', { name: 'Chỉ dẫn agent', exact: true })
      .fill(
        'In one English sentence, identify a requirement or missing information from the supplied brief and upstream outputs. Do not invent facts.',
      );
  }
  await page
    .getByRole('textbox', { name: 'Tài liệu đầu vào', exact: true })
    .fill(
      'Demo brief: A museum curator needs volunteer summaries of public exhibit notes. A curator must approve each summary. No budget is specified.',
    );
  await page.getByRole('button', { name: 'Chạy workflow', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Duyệt và tiếp tục', exact: true })).toBeVisible({
    timeout: 540_000,
  });
  await expect(page.getByRole('button', { name: 'Xuất Markdown', exact: true })).toBeDisabled();
  await page.screenshot({ path: 'artifacts/local/workflow-studio-review.png' });
  await application!.close();
  application = undefined;
  await launch(directory);
  await page
    .locator('.studio-library .studio-list-item')
    .filter({ hasText: 'Cần bạn duyệt' })
    .click();
  await expect(page.getByRole('button', { name: 'Duyệt và tiếp tục', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Duyệt và tiếp tục', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Xuất Markdown', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Chọn bước Báo cáo cuối', exact: true }).click();
  await expect(page.locator('.studio-output pre')).not.toHaveText('Chưa có kết quả ở bước này.');
  await page.getByText(/Timeline & audit/).click();
  await page.getByRole('button', { name: 'Verify ledger', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Hash chain hợp lệ');
  const runs = await page.evaluate(() => window.sand.studio.runs());
  expect(runs.ok).toBe(true);
  if (!runs.ok) throw new Error('Missing runs');
  const result = await page.evaluate((id) => window.sand.studio.get(id), runs.value[0]!.id);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('Missing run');
  expect(
    new Set(result.value.nodes.filter((n) => n.result).map((n) => n.result!.requestedModel)).size,
  ).toBe(2);
  expect(result.value.nodes.filter((n) => n.result).map((n) => n.attempt)).toEqual([1, 1, 1]);
  // Test-only native chooser substitution; the production IPC writer and real file are exercised.
  const output = path.join(directory, 'verified-report.md');
  await application!.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, output);
  await page.getByRole('button', { name: 'Xuất Markdown', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Đã xuất:');
  const markdown = await readFile(output, 'utf8');
  expect(markdown).toContain(result.value.id);
  expect(markdown).toContain('Input SHA-256:');
  await page.getByRole('button', { name: 'Xuất Markdown', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('File đã tồn tại');
  expect(await readFile(output, 'utf8')).toBe(markdown);
  await page.getByRole('button', { name: 'Đóng thông báo', exact: true }).click();
  await page.locator('.studio-main').evaluate((element) => (element.scrollTop = 0));
  await page.screenshot({ path: 'artifacts/local/workflow-studio-complete.png' });
});

import { createTemplate } from '../../packages/studio/src/schema';
test('OS vault protects an actual canary credential and exposes only configured status', async () => {
  await mkdir('.runtime', { recursive: true });
  const directory = await mkdtemp(path.resolve('.runtime/vault-desktop-'));
  const canary = 'unit-test-vault-canary-' + crypto.randomUUID();
  await launch(directory, { OPENAI_API_KEY: canary });
  const result = await page.evaluate(() => window.sand.studio.security());
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('missing security');
  expect(result.value.vaultAvailable).toBe(true);
  expect(
    await page.evaluate(() => window.sand.studio.storeEnvironmentKey('OPENAI_API_KEY')),
  ).toMatchObject({ ok: true, value: { stored: true } });
  expect(
    (await readFile(path.join(directory, 'credentials.enc'))).includes(Buffer.from(canary)),
  ).toBe(false);
  expect(await page.locator('body').textContent()).not.toContain(canary);
  await application!.close();
  application = undefined;
  await launch(directory);
  const restored = await page.evaluate(() => window.sand.studio.security());
  expect(restored).toMatchObject({ ok: true, value: { providers: { OPENAI_API_KEY: true } } });
  expect(JSON.stringify(restored)).not.toContain(canary);
  expect(
    await page.evaluate(() => window.sand.studio.removeStoredKey('OPENAI_API_KEY')),
  ).toMatchObject({ ok: true });
});
test('live tool approval survives a full Electron restart and re-granted workspace, then executes exactly once', async () => {
  test.skip(
    process.env.SAND_STUDIO_LIVE_TESTS !== '1',
    'Requires actual Ollama with a tool-capable local model; no fake success.',
  );
  test.setTimeout(300000);
  await mkdir('.runtime', { recursive: true });
  const directory = await mkdtemp(path.resolve('.runtime/tool-desktop-')),
    repository = path.join(directory, 'workspace');
  await mkdir(repository);
  await writeFile(
    path.join(repository, 'brief.md'),
    'Museum volunteers summarize exhibit notes. A curator approves publication. Budget is unspecified.',
  );
  await launch(directory, { SAND_TEST_REPOSITORY: repository });
  const d = createTemplate();
  d.name = 'Governed desktop tool demo';
  d.nodes = [
    {
      ...d.nodes[0]!,
      model: process.env.SAND_TOOL_MODEL ?? 'qwen2.5-coder:7b',
      toolProtocol: 'json',
      tools: ['repo_read'],
      maxOutputTokens: 512,
      instructions:
        'First request repo_read with exactly {"path":"brief.md"}. After the actual tool result, finish with a short summary. Do not request another tool.',
    },
    { ...d.nodes[4]!, dependsOn: ['analyst'] },
  ];
  expect(await page.evaluate((definition) => window.sand.studio.save(definition), d)).toMatchObject(
    { ok: true },
  );
  await page.reload();
  await page.getByRole('button', { name: 'Chọn repository cho agent', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Tài liệu đầu vào', exact: true })
    .fill('Read brief.md through the tool and summarize.');
  await page.getByRole('button', { name: 'Chạy workflow', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Cho phép đúng lần gọi này', exact: true }),
  ).toBeVisible({ timeout: 180000 });
  const list = await page.evaluate(() => window.sand.studio.runs());
  if (!list.ok) throw new Error('runs unavailable');
  const id = list.value[0]!.id;
  const pending = await page.evaluate((id) => window.sand.studio.approvals(id), id);
  expect(pending).toMatchObject({ ok: true, value: [{ state: 'pending', tool: 'repo_read' }] });
  await page.screenshot({ path: 'artifacts/local/governed-tool-approval.png' });
  await application!.close();
  application = undefined;
  await launch(directory, { SAND_TEST_REPOSITORY: repository });
  await page.getByRole('button', { name: 'Chọn repository cho agent', exact: true }).click();
  await page
    .locator('.studio-library .studio-list-item')
    .filter({ hasText: 'Cần bạn duyệt' })
    .click();
  await page.getByRole('button', { name: 'Cho phép đúng lần gọi này', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Xuất Markdown', exact: true })).toBeEnabled({
    timeout: 180000,
  });
  const completed = await page.evaluate((id) => window.sand.studio.get(id), id);
  expect(completed.ok).toBe(true);
  if (!completed.ok) throw new Error('run unavailable');
  expect(completed.value.events.filter((e) => e.type === 'tool.started')).toHaveLength(1);
  expect(completed.value.events.filter((e) => e.type === 'model.turn_completed')).toHaveLength(2);
  expect(await page.evaluate((id) => window.sand.studio.verify(id), id)).toMatchObject({
    ok: true,
    value: { valid: true },
  });
  await page.getByRole('button', { name: 'Chọn bước Báo cáo cuối', exact: true }).click();
  await page.screenshot({ path: 'artifacts/local/governed-tool-complete.png' });
});
