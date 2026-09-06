import * as monaco from 'monaco-editor/editor/editor.api.js';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import 'monaco-editor/languages/definitions/typescript/register.js';
import 'monaco-editor/languages/definitions/javascript/register.js';
import 'monaco-editor/languages/definitions/python/register.js';
import 'monaco-editor/languages/definitions/markdown/register.js';
import 'monaco-editor/languages/definitions/shell/register.js';
import { loader } from '@monaco-editor/react';
(globalThis as typeof globalThis & { MonacoEnvironment: object }).MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco });
monaco.editor.defineTheme('sand-light', { base: 'vs', inherit: true, rules: [{ token: 'comment', foreground: '91958b', fontStyle: 'italic' }, { token: 'keyword', foreground: '08786d' }, { token: 'string', foreground: '986239' }], colors: { 'editor.background': '#fbfaf7', 'editor.foreground': '#35423b', 'editorLineNumber.foreground': '#b2b6a9', 'editor.lineHighlightBackground': '#f0efe8', 'editor.selectionBackground': '#cee9df', 'editorCursor.foreground': '#08786d' } });
monaco.editor.defineTheme('sand-dark', { base: 'vs-dark', inherit: true, rules: [{ token: 'comment', foreground: '768a7e' }, { token: 'keyword', foreground: '74c9b5' }], colors: { 'editor.background': '#1c2522', 'editor.foreground': '#e0e6df', 'editorLineNumber.foreground': '#68766f', 'editor.lineHighlightBackground': '#27312c', 'editor.selectionBackground': '#365f50', 'editorCursor.foreground': '#83d8be' } });
export function language(file: string): string { return ({ ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', py: 'python', md: 'markdown', sh: 'shell', css: 'css', html: 'html', json: 'json', yml: 'yaml', yaml: 'yaml', sql: 'sql' } as Record<string, string>)[file.split('.').pop() || ''] || 'plaintext'; }


