import {mkdir, cp, writeFile, readFile, lstat, realpath, rm} from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { build as viteBuild } from 'vite';

await build({
  entryPoints: { main: 'apps/desktop/src/main.ts', preload: 'apps/desktop/src/preload.ts' },
  bundle: true,
  outdir: 'dist/desktop',
  platform: 'node',
  format: 'cjs',
  outExtension: { '.js': '.cjs' },
  external: ['electron'],
  sourcemap: false,
  target: 'node24'
});
await viteBuild({ configFile: 'apps/desktop/vite.config.ts' });

// Only remove this build's generated staging directory, after resolving its boundary.
const workspace = await realpath(process.cwd());
const stage = path.resolve(workspace, 'dist/package');
const stageStat = await lstat(stage).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
if (stageStat) {
  const resolvedStage = await realpath(stage);
  if (stageStat.isSymbolicLink() || resolvedStage !== stage || !resolvedStage.startsWith(workspace + path.sep)) {
    throw new Error('Refusing to clear staging outside the workspace');
  }
  await rm(stage, {recursive:true});
}
await mkdir('dist/package/dist', {recursive:true});
await cp('dist/desktop', 'dist/package/dist/desktop', {recursive:true});
await cp('dist/renderer', 'dist/package/dist/renderer', {recursive:true});
const manifest=JSON.parse(await readFile('package.json','utf8'));
await writeFile('dist/package/package.json', JSON.stringify({name:manifest.name,version:manifest.version,description:manifest.description,author:'SAND contributors',license:'UNLICENSED',main:'dist/desktop/main.cjs',dependencies:{}},null,2));
