/**
 * The ONLY bridge between the React renderer and Electron.
 * Each function maps to one validated IPC channel in main.cjs.
 * No generic invoke(), no Node APIs, no ipcRenderer exposed.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nexus', Object.freeze({
  isDesktop: true,
  appInfo: () => ipcRenderer.invoke('app:info'),
  setTheme: (theme) => ipcRenderer.invoke('window:setTheme', String(theme)),
  openAuthUrl: (url) => ipcRenderer.invoke('shell:openAuthUrl', String(url)),
  hub: Object.freeze({
    status: () => ipcRenderer.invoke('hub:status'),
    enable: () => ipcRenderer.invoke('hub:enable'),
    disable: () => ipcRenderer.invoke('hub:disable'),
  }),
  google: Object.freeze({
    listen: () => ipcRenderer.invoke('google:listen'),
    wait: () => ipcRenderer.invoke('google:wait'),
    cancel: () => ipcRenderer.invoke('google:cancel'),
  }),
  settings: Object.freeze({
    get: () => ipcRenderer.invoke('settings:get'),
    setServerUrl: (url) => ipcRenderer.invoke('settings:setServerUrl', String(url)),
  }),
  session: Object.freeze({
    save: (token) => ipcRenderer.invoke('session:save', String(token)),
    load: () => ipcRenderer.invoke('session:load'),
    clear: () => ipcRenderer.invoke('session:clear'),
  }),
}));
