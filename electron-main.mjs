import { app, BrowserWindow, dialog, Menu, Tray } from 'electron';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { closeSync, existsSync, openSync } from 'node:fs';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSettings, validateSettings } from './settings-store.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const serverFile = join(root, 'server.mjs');
const bundledCore = join(root, 'vendor', 'mihomo', 'mihomo.exe');
app.setName('代理分发器');
Menu.setApplicationMenu(null);

let backend;
let backendPort;
let controlToken;
let backendStartError;
let quitting = false;
let window;
let tray;
let desktopSettings = validateSettings({});

function showWindow() {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function configureTray() {
  if (desktopSettings.closeBehavior !== 'tray') {
    if (tray) { tray.destroy(); tray = null; }
    return;
  }
  if (tray) return;
  tray = new Tray(join(root, 'assets', 'tray.png'));
  tray.setToolTip('代理分发器 · 共享代理内核运行中');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主窗口', click: showWindow },
    { label: '退出并停止代理', click: () => app.quit() }
  ]));
  tray.on('double-click', showWindow);
}

function applyDesktopSettings(next) {
  const validated = validateSettings(next);
  if (process.platform === 'win32') {
    const portable = process.execPath.toLowerCase().endsWith('proxy dispatcher.exe');
    if (validated.autoStart && !portable) throw new Error('开机自启只能在打包后的桌面版设置');
    if (portable) {
      app.setLoginItemSettings({ openAtLogin: validated.autoStart, path: process.execPath });
      const actual = app.getLoginItemSettings({ path: process.execPath }).openAtLogin;
      if (actual !== validated.autoStart) throw new Error('Windows 开机自启设置未生效');
    }
  }
  desktopSettings = validated;
  configureTray();
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const port = socket.address().port;
      socket.close(() => resolve(port));
    });
  });
}

async function migrateExistingState(stateFile) {
  if (existsSync(stateFile)) return;
  const projectRoot = resolve(dirname(process.execPath), '..', '..');
  try {
    const packageInfo = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
    if (packageInfo.name === 'proxy-dispatcher') {
      const legacyFile = join(projectRoot, 'data', 'state.json');
      if (existsSync(legacyFile)) {
        await copyFile(legacyFile, stateFile);
        return;
      }
    }
  } catch { /* The portable app may have been moved outside the project. */ }

  let legacyState;
  try {
    const health = await fetch('http://127.0.0.1:4173/api/health', { signal: AbortSignal.timeout(1500) });
    if (!health.ok || (await health.json()).port !== 4173) return;
    const response = await fetch('http://127.0.0.1:4173/api/state', { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return;
    legacyState = await response.json();
  } catch { return; }
  if (!Array.isArray(legacyState.sources) || !Array.isArray(legacyState.proxies) || !Array.isArray(legacyState.apps)) return;
  if (!legacyState.sources.length && !legacyState.proxies.length && !legacyState.apps.length) return;
  await writeFile(stateFile, JSON.stringify(legacyState), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}

async function startBackend() {
  if (!existsSync(bundledCore)) throw new Error('缺少项目自带的 Mihomo 内核');
  const dataDir = join(app.getPath('userData'), 'data');
  await mkdir(dataDir, { recursive: true });
  try { desktopSettings = await loadSettings(join(dataDir, 'settings.json')); }
  catch (error) { console.error('桌面设置读取失败，使用默认值:', error.message); desktopSettings = validateSettings({}); }
  applyDesktopSettings(desktopSettings);
  await migrateExistingState(join(dataDir, 'state.json'));
  backendPort = await freePort();
  controlToken = randomBytes(32).toString('hex');
  const logFd = openSync(join(dataDir, 'desktop-server.log'), 'a');
  try {
    backend = spawn(process.execPath, [serverFile], {
      cwd: root,
      windowsHide: true,
      stdio: ['ignore', logFd, logFd, 'ipc'],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        PORT: String(backendPort),
        STATE_FILE: join(dataDir, 'state.json'),
        ACTIVE_BRIDGES_FILE: join(dataDir, 'active-bridges.json'),
        SETTINGS_FILE: join(dataDir, 'settings.json'),
        MIHOMO_PATH: bundledCore,
        DESKTOP_CONTROL_TOKEN: controlToken
      }
    });
    const child = backend;
    child.once('error', error => { backendStartError = error; });
    child.on('message', message => {
      if (message?.type !== 'apply-settings') return;
      try {
        applyDesktopSettings(message.settings);
        child.send({ type: 'settings-applied', requestId: message.requestId });
      } catch (error) {
        child.send({ type: 'settings-applied', requestId: message.requestId, error: error.message });
      }
    });
  } finally { closeSync(logFd); }

  for (let attempt = 0; attempt < 240; attempt++) {
    if (backendStartError) throw new Error(`本机服务无法启动：${backendStartError.message}`);
    if (backend.exitCode !== null || backend.signalCode !== null) throw new Error('本机服务启动失败');
    try {
      const response = await fetch(`http://127.0.0.1:${backendPort}/api/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok && (await response.json()).port === backendPort) return;
    } catch { /* Startup is still in progress. */ }
    await delay(250);
  }
  throw new Error('本机服务启动超时');
}

async function stopBackend() {
  if (!backend) return;
  const child = backend;
  backend = null;
  try {
    await fetch(`http://127.0.0.1:${backendPort}/api/desktop/shutdown`, {
      method: 'POST',
      headers: { 'X-Desktop-Token': controlToken },
      signal: AbortSignal.timeout(3000)
    });
  } catch { /* Fall back to terminating the process tree below. */ }
  for (let attempt = 0; attempt < 20 && child.exitCode === null && child.signalCode === null; attempt++) await delay(100);
  if (child.exitCode === null && child.signalCode === null) {
    if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    else child.kill();
  }
}

async function createWindow() {
  await startBackend();
  const origin = `http://127.0.0.1:${backendPort}`;
  window = new BrowserWindow({
    title: '代理分发器',
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true }
  });
  window.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(`${origin}/`)) event.preventDefault(); });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.on('close', event => {
    if (!quitting && desktopSettings.closeBehavior === 'tray') { event.preventDefault(); window.hide(); }
  });
  await window.loadURL(`${origin}/`);
  window.show();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWindow);
  app.whenReady().then(createWindow).catch(error => {
    dialog.showErrorBox('代理分发器启动失败', error.message);
    app.quit();
  });
  app.on('window-all-closed', () => { if (desktopSettings.closeBehavior !== 'tray') app.quit(); });
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void stopBackend().finally(() => app.quit());
  });
}
