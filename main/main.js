// karaTin desktop — app entry.
'use strict';

const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');
const { WorkerManager } = require('./workers');
const store = require('./store');

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

let win = null;
let manager = null;

function sendToRenderer(channel, data) {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, data);
  }
}

// Never look like automation to Cloudflare.
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');

app.whenReady().then(() => {
  store.init();

  win = new BrowserWindow({
    width: 1360,
    height: 940,
    minWidth: 1000,
    minHeight: 760,
    title: 'karaTin',
    backgroundColor: '#101014',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, '..', 'preload', 'preload.gen.js'),
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  manager = new WorkerManager(win, sendToRenderer);
  manager.ensureWorkers(store.getSettings().workerCount);
  manager.layout();
  win.on('resize', () => manager.layout());

  /* ---- bridge from worker views ---- */
  ipcMain.on('kara:bridge', (event, json) => manager.routeBridge(event.sender.id, json));
  ipcMain.on('kara:login-state', (event, ok, detail) => manager.routeLoginState(event.sender.id, ok, detail));
  ipcMain.on('kara:log', (event, level, msg) => {
    if (level === 'error') console.error('[view]', msg);
  });

  /* ---- renderer UI ---- */
  ipcMain.handle('kara:get-settings', () => store.getSettings());
  ipcMain.handle('kara:save-settings', (event, patch) => {
    store.saveSettings(patch || {});
    return store.getSettings();
  });
  ipcMain.handle('kara:get-status', () => {
    manager.sendStatus();
    return true;
  });
  ipcMain.on('kara:start', () => manager.start());
  ipcMain.on('kara:stop', () => manager.stop());
  ipcMain.on('kara:otp', (event, index, code) => manager.submitOtp(index, code));
  ipcMain.on('kara:workers-changed', () => {
    if (!manager.running) {
      manager.ensureWorkers(manager.workerCount());
      manager.sendStatus();
    }
  });

  // Plain desktop Chrome UA on every worker partition (Electron UA trips Cloudflare).
  for (let i = 0; i < 4; i++) {
    try { session.fromPartition(`worker-${i}`).setUserAgent(DESKTOP_UA); } catch (e) { /* ignore */ }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && win === null) { /* single window app */ }
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
