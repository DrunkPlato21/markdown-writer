const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke('write-file', filePath, content),
  renameFile: (oldPath, newPath) => ipcRenderer.invoke('rename-file', oldPath, newPath),
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
  saveFileDialog: () => ipcRenderer.invoke('save-file-dialog'),
  setTitle: (title) => ipcRenderer.invoke('set-title', title),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (data) => ipcRenderer.invoke('save-settings', data),
  toggleFullscreen: () => ipcRenderer.invoke('toggle-fullscreen'),
  setFullscreen: (on) => ipcRenderer.invoke('set-fullscreen', on),
  showInFolder: (filePath) => ipcRenderer.invoke('show-in-folder', filePath),
  saveDraft: (content, filePath, cursorPos) =>
    ipcRenderer.invoke('save-draft', content, filePath, cursorPos),
  loadDraft: () => ipcRenderer.invoke('load-draft'),
  clearDraft: () => ipcRenderer.invoke('clear-draft'),
  ensureDir: (dirPath) => ipcRenderer.invoke('ensure-dir', dirPath),
  getDocumentsPath: () => ipcRenderer.invoke('get-documents-path'),
  onOpenFile: (callback) =>
    ipcRenderer.on('open-file-path', (_event, filePath) => callback(filePath)),
});
