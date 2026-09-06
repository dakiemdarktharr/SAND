import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './tests/e2e', timeout: 90000, expect: { timeout: 15000 }, workers: 1, fullyParallel: false, reporter: [['list'], ['json', { outputFile: 'artifacts/local/e2e-results.json' }]], use: { trace: 'retain-on-failure' } });

