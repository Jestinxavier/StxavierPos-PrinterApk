// main.js — Electron Main Process
// POS Bridge Service for St Xavier Oils

const { app, Tray, Menu, nativeImage, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const AutoLaunch = require('auto-launch');
const { startServer, stopServer, getServerStatus, getBridgeConfig } = require('./server');
const { listWindowsPrinters, getSelectedPrinter, setSelectedPrinter } = require('./printer');
const logger = require('./logger');
require('dotenv').config();

// ─── Prevent multiple instances ───────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

// ─── Globals ──────────────────────────────────────────────────────────────────
let tray = null;
let statusWindow = null;
let serverRunning = false;

// ─── Auto Launch Setup ────────────────────────────────────────────────────────
const autoLauncher = new AutoLaunch({
  name: 'POS Bridge',
  path: app.getPath('exe'),
  isHidden: true,
});

async function enableAutoLaunch() {
  try {
    const enabled = await autoLauncher.isEnabled();
    if (!enabled) {
      await autoLauncher.enable();
      logger.info('Auto-launch enabled');
    }
  } catch (err) {
    logger.error('Auto-launch setup failed:', err.message);
  }
}

// ─── Status Window (optional UI) ──────────────────────────────────────────────
function createStatusWindow() {
  if (statusWindow) {
    statusWindow.show();
    statusWindow.focus();
    return;
  }

  statusWindow = new BrowserWindow({
    width: 480,
    height: 560,
    resizable: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    icon: path.join(__dirname, '../assets/icon.ico'),
  });

  statusWindow.loadFile(path.join(__dirname, 'status.html'));

  statusWindow.on('closed', () => {
    statusWindow = null;
  });

  // Close when loses focus
  statusWindow.on('blur', () => {
    if (statusWindow) statusWindow.hide();
  });
}

// ─── Tray Icon & Menu ─────────────────────────────────────────────────────────
function buildTrayMenu() {
  const printerStatus = getServerStatus();
  const bridgeConfig = getBridgeConfig();
  const bridgeLabel = `${bridgeConfig.host}:${bridgeConfig.port} (${bridgeConfig.protocol.toUpperCase()})`;

  return Menu.buildFromTemplate([
    {
      label: '🖨  POS Bridge Service',
      enabled: false,
    },
    { type: 'separator' },
    {
      label: `Status: ${serverRunning ? '🟢 Running' : '🔴 Stopped'}`,
      enabled: false,
    },
    {
      label: `Printer: ${printerStatus.printerConnected ? '✅ Connected' : '❌ Not Found'}`,
      enabled: false,
    },
    {
      label: `Bridge: ${serverRunning ? bridgeLabel : '—'}`,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: serverRunning ? 'Stop Service' : 'Start Service',
      click: async () => {
        if (serverRunning) {
          await stopBridge();
        } else {
          await startBridge();
        }
        refreshTray();
      },
    },
    {
      label: 'View Status',
      click: () => createStatusWindow(),
    },
    { type: 'separator' },
    {
      label: 'Open Log File',
      click: () => {
        const { shell } = require('electron');
        shell.openPath(logger.logFilePath);
      },
    },
    { type: 'separator' },
    {
      label: 'Exit',
      click: () => {
        app.isQuiting = true;
        stopServer();
        app.quit();
      },
    },
  ]);
}

function refreshTray() {
  const bridgeConfig = getBridgeConfig();
  if (tray) {
    tray.setContextMenu(buildTrayMenu());
    tray.setToolTip(
      `POS Bridge — ${serverRunning ? `Running on ${bridgeConfig.protocol}://localhost:${bridgeConfig.port}` : 'Stopped'}`
    );
  }
}

function createTray() {
  // Create a simple programmatic icon if no .ico file exists
  let icon;
  try {
    icon = nativeImage.createFromPath(path.join(__dirname, '../assets/icon.ico'));
    if (icon.isEmpty()) throw new Error('empty');
  } catch {
    // Fallback: 16x16 green circle as PNG buffer
    icon = nativeImage.createFromDataURL(getTrayIconDataURL(serverRunning));
  }

  tray = new Tray(icon);
  tray.setToolTip('POS Bridge — Starting...');
  tray.setContextMenu(buildTrayMenu());

  // Double-click tray icon → show status window
  tray.on('double-click', () => createStatusWindow());
}

function getTrayIconDataURL(active) {
  // Simple colored circle SVG → dataURL
  const color = active ? '#22c55e' : '#ef4444';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">
    <circle cx="8" cy="8" r="7" fill="${color}"/>
    <text x="8" y="12" text-anchor="middle" font-size="9" fill="white" font-family="Arial">P</text>
  </svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

// ─── Bridge Start/Stop ────────────────────────────────────────────────────────
async function startBridge() {
  const bridgeConfig = getBridgeConfig();
  try {
    await startServer();
    serverRunning = true;
    logger.info(`POS Bridge service started on ${bridgeConfig.url}`);
    tray && tray.setToolTip(`POS Bridge — Running on ${bridgeConfig.protocol}://localhost:${bridgeConfig.port}`);
  } catch (err) {
    serverRunning = false;
    logger.error('Failed to start bridge:', err.message);
    dialog.showErrorBox('POS Bridge Error', `Could not start service:\n${err.message}`);
  }
}

async function stopBridge() {
  try {
    await stopServer();
    serverRunning = false;
    logger.info('POS Bridge service stopped');
  } catch (err) {
    logger.error('Failed to stop bridge:', err.message);
  }
}

// ─── IPC handlers (for status window) ────────────────────────────────────────
ipcMain.handle('get-status', () => ({
  serverRunning,
  bridge: getBridgeConfig(),
  ...getServerStatus(),
}));

ipcMain.handle('start-server', async () => {
  await startBridge();
  refreshTray();
  return { serverRunning };
});

ipcMain.handle('stop-server', async () => {
  await stopBridge();
  refreshTray();
  return { serverRunning };
});

// ─── Printer picker IPC ───────────────────────────────────────────────────────
ipcMain.handle('list-printers', () => {
  try { return listWindowsPrinters(); }
  catch (err) { logger.error('list-printers error:', err.message); return []; }
});

ipcMain.handle('get-printer', () => getSelectedPrinter());

ipcMain.handle('set-printer', (_, name) => {
  setSelectedPrinter(name);
  refreshTray();
  return { ok: true };
});

// ─── App Lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  // Hide from dock/taskbar — this is a background service
  if (app.dock) app.dock.hide();

  await enableAutoLaunch();
  createTray();
  await startBridge();
  refreshTray();

  logger.info('POS Bridge app ready');
});

app.on('window-all-closed', (e) => {
  // Don't quit when all windows close — stay in tray
  e.preventDefault();
});

app.on('before-quit', () => {
  app.isQuiting = true;
});

// Handle second instance
app.on('second-instance', () => {
  createStatusWindow();
});
