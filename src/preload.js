// preload.js — Context bridge between renderer (status.html) and main process

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('posbridge', {
  // Server control
  getStatus:    () => ipcRenderer.invoke('get-status'),
  startServer:  () => ipcRenderer.invoke('start-server'),
  stopServer:   () => ipcRenderer.invoke('stop-server'),

  // Printer selection
  listPrinters:  ()     => ipcRenderer.invoke('list-printers'),
  getPrinter:    ()     => ipcRenderer.invoke('get-printer'),
  setPrinter:    (name) => ipcRenderer.invoke('set-printer', name),
});
