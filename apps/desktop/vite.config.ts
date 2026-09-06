import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
export default defineConfig({ root: path.resolve('apps/desktop'), base: './', plugins: [react()], build: { outDir: '../../dist/renderer', emptyOutDir: true }, worker: { format: 'es' } });
