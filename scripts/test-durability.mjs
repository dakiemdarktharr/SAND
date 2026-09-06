import { spawn } from 'node:child_process';
const live = process.argv.includes('--live-registry');
const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'tests/integration/workflows.integration.test.ts'], {
  stdio: 'inherit', windowsHide: true,
  env: { ...process.env, SAND_TEMPORAL_TESTS: '1', ...(live ? { SAND_OPENROUTER_PUBLIC_DISCOVERY: '1' } : {}) },
});
child.on('error', () => { process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
