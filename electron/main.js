const { app, BrowserWindow, Menu, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const isDev = !app.isPackaged;
let mainWindow;

// Fix Windows taskbar icon when pinned
app.setAppUserModelId('com.markdown-writer.app');

// ---- Settings persistence ----

const settingsPath = path.join(app.getPath('userData'), 'settings.json');
const draftPath = path.join(app.getPath('userData'), 'draft.md');
const draftMetaPath = path.join(app.getPath('userData'), 'draft-meta.json');

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch {
    return {};
  }
}

function writeSettings(data) {
  const current = readSettings();
  const merged = { ...current, ...data };
  fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2), 'utf-8');
}

// ---- Window ----

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 480,
    minHeight: 400,
    backgroundColor: '#0f0f0f',
    show: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#181410',
      symbolColor: '#968c7b',
      height: 44,
    },
    icon: path.join(__dirname, '..', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Open external links in system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Spellcheck
  mainWindow.webContents.session.setSpellCheckerLanguages(['en-US']);

  mainWindow.webContents.on('context-menu', (_event, params) => {
    const template = [];

    if (params.misspelledWord) {
      if (params.dictionarySuggestions.length === 0) {
        template.push({ label: 'No suggestions', enabled: false });
      } else {
        for (const suggestion of params.dictionarySuggestions) {
          template.push({
            label: suggestion,
            click: () => mainWindow.webContents.replaceMisspelling(suggestion),
          });
        }
      }
      template.push({ type: 'separator' });
      template.push({
        label: 'Add to Dictionary',
        click: () =>
          mainWindow.webContents.session.addWordToSpellCheckerDictionary(
            params.misspelledWord
          ),
      });
      template.push({ type: 'separator' });
    }

    if (params.isEditable) {
      template.push(
        { role: 'cut', enabled: params.editFlags.canCut },
        { role: 'copy', enabled: params.editFlags.canCopy },
        { role: 'paste', enabled: params.editFlags.canPaste },
        { type: 'separator' },
        { role: 'selectAll' }
      );
    } else if (params.selectionText) {
      template.push({ role: 'copy' });
    }

    if (template.length > 0) {
      Menu.buildFromTemplate(template).popup({ window: mainWindow });
    }
  });

  // On load: open CLI file arg if given, otherwise reopen the last file.
  const fileArg = process.argv.find(
    (arg) =>
      !arg.startsWith('-') &&
      !arg.includes('electron') &&
      !arg.includes('node_modules') &&
      /\.(md|markdown|txt)$/i.test(arg)
  );

  mainWindow.webContents.once('did-finish-load', () => {
    if (fileArg) {
      mainWindow.webContents.send('open-file-path', path.resolve(fileArg));
    } else {
      const settings = readSettings();
      if (settings.lastFile && fs.existsSync(settings.lastFile)) {
        mainWindow.webContents.send('open-file-path', settings.lastFile);
      }
    }
  });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([]));
  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});

// ---- IPC Handlers ----

ipcMain.handle('read-file', async (_event, filePath) => {
  return fs.readFileSync(filePath, 'utf-8');
});

ipcMain.handle('rename-file', async (_event, oldPath, newPath) => {
  try {
    fs.renameSync(oldPath, newPath);
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle('write-file', async (_event, filePath, content) => {
  fs.writeFileSync(filePath, content, 'utf-8');
  return true;
});

ipcMain.handle('open-file-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    filters: [
      { name: 'Markdown', extensions: ['md', 'markdown'] },
      { name: 'Text', extensions: ['txt'] },
      { name: 'All Files', extensions: ['*'] },
    ],
    properties: ['openFile'],
  });
  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

ipcMain.handle('save-file-dialog', async () => {
  const result = await dialog.showSaveDialog(mainWindow, {
    filters: [
      { name: 'Markdown', extensions: ['md'] },
      { name: 'Text', extensions: ['txt'] },
    ],
    defaultPath: 'Untitled.md',
  });
  if (!result.canceled) {
    return result.filePath;
  }
  return null;
});

ipcMain.handle('set-title', (_event, title) => {
  if (mainWindow) mainWindow.setTitle(title);
});

ipcMain.handle('ensure-dir', (_event, dirPath) => {
  fs.mkdirSync(dirPath, { recursive: true });
  return true;
});

ipcMain.handle('get-documents-path', () => {
  return app.getPath('documents').replace(/\\/g, '/');
});

ipcMain.handle('get-settings', () => {
  return readSettings();
});

ipcMain.handle('save-settings', (_event, data) => {
  writeSettings(data);
  return true;
});

ipcMain.handle('show-in-folder', (_event, filePath) => {
  if (filePath && fs.existsSync(filePath)) {
    shell.showItemInFolder(filePath);
    return true;
  }
  return false;
});

ipcMain.handle('toggle-fullscreen', () => {
  if (mainWindow) {
    mainWindow.setFullScreen(!mainWindow.isFullScreen());
    return mainWindow.isFullScreen();
  }
  return false;
});

ipcMain.handle('set-fullscreen', (_event, on) => {
  if (mainWindow) mainWindow.setFullScreen(!!on);
  return mainWindow?.isFullScreen() ?? false;
});

// ---- Draft persistence (crash recovery) ----

ipcMain.handle('save-draft', (_event, content, filePath, cursorPos) => {
  fs.writeFileSync(draftPath, content, 'utf-8');
  fs.writeFileSync(draftMetaPath, JSON.stringify({
    filePath: filePath || null,
    cursorPos: cursorPos || 0,
    savedAt: Date.now(),
  }), 'utf-8');
  return true;
});

ipcMain.handle('load-draft', () => {
  try {
    const content = fs.readFileSync(draftPath, 'utf-8');
    const meta = JSON.parse(fs.readFileSync(draftMetaPath, 'utf-8'));
    return { content, ...meta };
  } catch {
    return null;
  }
});

ipcMain.handle('clear-draft', () => {
  try { fs.unlinkSync(draftPath); } catch {}
  try { fs.unlinkSync(draftMetaPath); } catch {}
  return true;
});
