// preload.js — Context bridge between renderer (status.html) and main process

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('posbridge', {
  getStatus:   () => ipcRenderer.invoke('get-status'),
  startServer: () => ipcRenderer.invoke('start-server'),
  stopServer:  () => ipcRenderer.invoke('stop-server'),
});
