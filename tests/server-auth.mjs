import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServerAuth } from '../server-auth.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise(resolve => {
  const server = createServer();
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});

test('real server auth gates data, handles login/logout/change, throttles and survives restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pd-auth-test-'));
  const password = randomBytes(24).toString('hex');
  const newPassword = randomBytes(24).toString('hex');
  const file = join(directory, 'admin-auth.json');
  let child, base;
  let output = '';
  const start = async () => {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ['server.mjs'], { cwd: new URL('..', import.meta.url), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SERVER_MODE: '1', HOST: '127.0.0.1', PORT: String(port), PUBLIC_ORIGIN: 'https://management.example', AUTH_FILE: file, STATE_FILE: join(directory, 'state.json'), SETTINGS_FILE: join(directory, 'settings.json'), ACTIVE_BRIDGES_FILE: join(directory, 'bridges.json'), EVENT_LOG_FILE: join(directory, 'events.jsonl') } });
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(output);
      try { if ((await fetch(base + '/api/health')).ok) return; } catch {}
      await sleep(50);
    }
    throw new Error('isolated server startup timed out');
  };
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  };
  const request = (path, { method = 'GET', body, cookie, headers = {} } = {}) => fetch(base + path, { method, redirect: 'manual', headers: { ...(method === 'POST' || method === 'PUT' ? { 'X-Requested-With': 'ProxyDispatcher', 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const cookieFrom = response => response.headers.get('set-cookie').split(';')[0];
  const proxyHeaders = { 'X-Forwarded-Proto': 'https', 'X-Real-IP': '192.0.2.8', Origin: 'https://management.example' };
  try {
    await start();
    assert.equal((await request('/')).status, 303);
    assert.equal((await request('/api/auth/status', { headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'cors' } })).status, 403);
    assert.equal((await request('/app.js')).status, 303);
    assert.equal((await request('/login')).status, 200);
    for (const path of ['/api/state', '/api/settings', '/api/backup', '/api/bridges', '/api/logs', '/api/telemetry']) assert.equal((await request(path)).status, 401, path);
    assert.equal((await (await request('/api/auth/status')).json()).canSetup, true);
    assert.equal((await (await request('/api/auth/status', { headers: proxyHeaders })).json()).canSetup, false);
    assert.equal((await request('/api/auth/setup', { method: 'POST', body: { password }, headers: proxyHeaders })).status, 403);
    assert.equal((await request('/api/auth/setup', { method: 'POST', body: { password }, headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await request('/api/auth/setup', { method: 'POST', body: { password }, headers: { 'X-Requested-With': '' } })).status, 403);
    assert.equal((await request('/api/auth/setup', { method: 'POST', body: { password: 'short' } })).status, 400);
    const setup = await request('/api/auth/setup', { method: 'POST', body: { password } });
    assert.equal(setup.status, 200);
    assert.match(setup.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    const initialCookie = cookieFrom(setup);
    assert.equal((await request('/api/state', { cookie: initialCookie })).status, 200);
    const page = await (await request('/', { cookie: initialCookie })).text();
    assert.match(page, /data-server-mode="1"/);
    assert.match(page, /server-session.js/);
    const hash = await readFile(file, 'utf8');
    assert.equal(hash.includes(password), false);
    assert.equal(JSON.parse(hash).kdf, 'scrypt');
    if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await request('/api/auth/setup', { method: 'POST', body: { password: newPassword } })).status, 403);
    assert.equal(await readFile(file, 'utf8'), hash);
    assert.equal((await request('/api/state', { cookie: `pd_session=${randomBytes(32).toString('hex')}` })).status, 401);
    const state = { sources: [], proxies: [], apps: [{ id: 'persisted-auth-test', name: 'auth-test', proxyId: '' }] };
    assert.equal((await request('/api/state', { method: 'PUT', body: state, cookie: initialCookie, headers: { 'X-Requested-With': '' } })).status, 403);
    assert.equal((await request('/api/state', { method: 'PUT', body: state, cookie: initialCookie, headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await request('/api/state', { method: 'PUT', body: state, cookie: initialCookie })).status, 200);
    const login = await request('/api/auth/login', { method: 'POST', body: { username: 'admin', password }, headers: proxyHeaders });
    assert.equal(login.status, 200);
    assert.match(login.headers.get('set-cookie'), /; Secure$/);
    const secondCookie = cookieFrom(login);
    assert.equal((await request('/api/auth/logout', { method: 'POST', cookie: initialCookie })).status, 200);
    assert.equal((await request('/api/state', { cookie: initialCookie })).status, 401);
    assert.equal((await request('/api/state', { cookie: secondCookie })).status, 200);
    assert.equal((await request('/api/auth/password', { method: 'POST', cookie: secondCookie, body: { currentPassword: password, newPassword } })).status, 200);
    assert.equal((await request('/api/state', { cookie: secondCookie })).status, 401);
    assert.equal((await request('/api/auth/login', { method: 'POST', body: { username: 'admin', password } })).status, 401);
    await stop();
    await start();
    assert.equal((await (await request('/api/auth/status')).json()).configured, true);
    assert.equal((await request('/api/state', { cookie: secondCookie })).status, 401);
    const afterRestart = await request('/api/auth/login', { method: 'POST', body: { username: 'admin', password: newPassword } });
    assert.equal(afterRestart.status, 200);
    assert.deepEqual((await (await request('/api/state', { cookie: cookieFrom(afterRestart) })).json()).apps, state.apps);
    for (let i = 0; i < 5; i++) assert.equal((await request('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'incorrect' }, headers: proxyHeaders })).status, 401);
    const limited = await request('/api/auth/login', { method: 'POST', body: { username: 'admin', password: newPassword }, headers: proxyHeaders });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    const logs = await readFile(join(directory, 'events.jsonl'), 'utf8');
    for (const secret of [password, newPassword, initialCookie.slice(11), secondCookie.slice(11)]) assert.equal((logs + output).includes(secret), false);
  } finally { await stop(); await rm(directory, { recursive: true, force: true }); }
});

test('background polling cannot extend idle or absolute session expiration; corrupt auth fails closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pd-auth-expiry-'));
  const file = join(directory, 'admin-auth.json');
  let time = 100;
  const req = { socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:4173' } };
  const res = { setHeader: (name, value) => { if (name === 'Set-Cookie') req.headers.cookie = value.split(';')[0]; } };
  try {
    const auth = await createServerAuth({ file, port: 4173, now: () => time, idleMs: 1000, lifetimeMs: 2500 });
    assert.equal(auth.checkRequest({ ...req, method: 'GET', headers: { ...req.headers, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' } }), true);
    assert.equal(auth.checkRequest({ ...req, method: 'POST', headers: { ...req.headers, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' } }), false);
    await auth.setup(req, res, randomBytes(24).toString('hex'));
    time += 999;
    assert.ok(auth.session(req));
    time += 1;
    assert.equal(auth.session(req), null);
    const otherFile = join(directory, 'second.json');
    const second = await createServerAuth({ file: otherFile, port: 4173, now: () => time, idleMs: 1000, lifetimeMs: 2500 });
    await second.setup(req, res, randomBytes(24).toString('hex'));
    for (let i = 0; i < 3; i++) { time += 800; assert.ok(second.session(req, true)); }
    time += 100;
    assert.equal(second.session(req), null);
    await writeFile(file, '{}');
    await assert.rejects(createServerAuth({ file, port: 4173 }), /哈希文件无效/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
