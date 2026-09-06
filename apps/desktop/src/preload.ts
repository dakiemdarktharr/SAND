import { contextBridge, ipcRenderer } from 'electron';
import type { Bridge } from './shared';
const bridge: Bridge = {
  repository: { open: () => ipcRenderer.invoke('repository:open'), list: () => ipcRenderer.invoke('repository:list'), read: path => ipcRenderer.invoke('repository:read', path), save: input => ipcRenderer.invoke('repository:save', input), status: () => ipcRenderer.invoke('repository:status'), diff: path => ipcRenderer.invoke('repository:diff', path) },
  control: { overview: () => ipcRenderer.invoke('control:overview'), projects: () => ipcRenderer.invoke('control:projects'), runs: () => ipcRenderer.invoke('control:runs'), create: (projectId, operationId) => ipcRenderer.invoke('control:create', { projectId, operationId }), events: (runId, after) => ipcRenderer.invoke('control:events', { runId, after }), cancel: (runId, operationId) => ipcRenderer.invoke('control:cancel', { runId, operationId }), models: () => ipcRenderer.invoke('control:models'), verify: () => ipcRenderer.invoke('control:verify') }
};
contextBridge.exposeInMainWorld('sand', bridge);
