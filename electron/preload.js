const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke('write-file', filePath, content),
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
  saveFileDialog: () => ipcRenderer.invoke('save-file-dialog'),
  setTitle: (title) => ipcRenderer.invoke('set-title', title),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (data) => ipcRenderer.invoke('save-settings', data),
  toggleFullscreen: () => ipcRenderer.invoke('toggle-fullscreen'),
  saveDraft: (content, filePath, cursorPos) =>
    ipcRenderer.invoke('save-draft', content, filePath, cursorPos),
  loadDraft: () => ipcRenderer.invoke('load-draft'),
  clearDraft: () => ipcRenderer.invoke('clear-draft'),
  onOpenFile: (callback) =>
    ipcRenderer.on('open-file-path', (_event, filePath) => callback(filePath)),
});
