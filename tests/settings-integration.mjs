import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise((resolvePort, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolvePort(port)); });
});

test('settings and data backup survive backend restart without touching desktop data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pd-settings-test-'));
  const token = 'isolated-test-control-token';
  let child;
  let base;
  const start = async () => {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ['server.mjs'], {
      cwd: root, windowsHide: true, stdio: 'ignore',
      env: {
        ...process.env, PORT: String(port),
        STATE_FILE: join(directory, 'state.json'),
        ACTIVE_BRIDGES_FILE: join(directory, 'active-bridges.json'),
        SETTINGS_FILE: join(directory, 'settings.json'),
        EVENT_LOG_FILE: join(directory, 'events.jsonl'),
        MIHOMO_PATH: join(root, 'vendor', 'mihomo', 'mihomo.exe'),
        DESKTOP_CONTROL_TOKEN: token
      }
    });
    for (let attempt = 0; attempt < 100; attempt++) {
      try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {}
      if (child.exitCode !== null) throw new Error('isolated backend exited');
      await sleep(100);
    }
    throw new Error('isolated backend did not start');
  };
  const json = async (path, method = 'GET', body) => {
    const response = await fetch(base + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const result = await response.json();
    if (!response.ok) throw new Error(`${path}: ${result.error}`);
    return result;
  };
  const stop = async () => {
    if (!child) return;
    const running = child;
    child = null;
    try { await fetch(base + '/api/desktop/shutdown', { method: 'POST', headers: { 'X-Desktop-Token': token } }); } catch {}
    for (let attempt = 0; attempt < 50 && running.exitCode === null; attempt++) await sleep(100);
    if (running.exitCode === null) running.kill();
  };
  try {
    await start();
    const initial = await json('/api/settings');
    assert.equal(initial.settings.probeConcurrency, 5);
    assert.equal(initial.desktopAvailable, false);
    const updated = await json('/api/settings', 'PUT', { probeConcurrency: 8, probeTimeoutSeconds: 20, startupPage: 'logs', restoreOnLaunch: false, coreLogLevel: 'info' });
    assert.equal(updated.settings.probeConcurrency, 8);
    const rawLine = '- {name: "smoke", type: ss, server: 127.0.0.1, port: 9, cipher: aes-128-gcm, password: "test-only"}';
    const state = { sources: [{ id: 'source-smoke', name: 'smoke', nodeCount: 1 }], proxies: [{ id: 'proxy-smoke', name: 'smoke', protocol: 'ss', server: '127.0.0.1', port: 9, rawLine, sourceId: 'source-smoke' }], apps: [{ id: 'app-smoke', name: 'smoke', proxyId: 'proxy-smoke' }] };
    await json('/api/state', 'PUT', state);
    const bridge = await json('/api/bridge/start', 'POST', { appId: 'app-smoke', name: 'smoke', rawLine });
    assert.equal(bridge.running, true);
    const backup = await json('/api/backup');
    assert.equal(backup.state.sources.length, 1);
    assert.equal(backup.activeBridges.length, 1);
    await json('/api/bridge/stop', 'POST', { appId: 'app-smoke' });
    await json('/api/state', 'PUT', { sources: [], proxies: [], apps: [] });
    const restored = await json('/api/backup/restore', 'POST', backup);
    assert.equal(restored.activeListeners, 1);
    await stat(restored.safetyFile);
    assert.equal((await json('/api/state')).sources.length, 1);
    assert.equal((await json('/api/bridges')).bridges.length, 1);
    const invalidBackup = { ...backup, activeBridges: [{ ...backup.activeBridges[0], port: 0 }] };
    const rejected = await fetch(base + '/api/backup/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(invalidBackup) });
    assert.equal(rejected.ok, false);
    assert.equal((await json('/api/state')).sources.length, 1);
    assert.equal((await json('/api/bridges')).bridges.length, 1);
    const restarted = await json('/api/bridge/restart', 'POST', {});
    assert.equal(restarted.restarted, 1);
    assert.equal((await json('/api/telemetry')).coreLogLevel, 'info');
    await stop();
    await start();
    assert.equal((await json('/api/settings')).settings.startupPage, 'logs');
    assert.equal((await json('/api/bridges')).bridges.length, 0);
    assert.equal((await json('/api/state')).sources.length, 1);
    assert.equal(JSON.parse(await readFile(join(directory, 'active-bridges.json'), 'utf8')).entries.length, 1);
  } finally {
    await stop();
    const target = resolve(directory);
    assert.ok(target.startsWith(resolve(tmpdir(), 'pd-settings-test-')));
    await rm(target, { recursive: true, force: true });
  }
});
