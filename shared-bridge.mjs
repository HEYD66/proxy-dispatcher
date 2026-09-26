import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const engine = process.env.MIHOMO_PATH || (process.platform === 'win32' ? join(root, 'vendor', 'mihomo', 'mihomo.exe') : 'mihomo');
const activeFile = process.env.ACTIVE_BRIDGES_FILE || join(root, 'data', 'active-bridges.json');
const requestedLimit = Number(process.env.MAX_ACTIVE_NODES || 200);
const maxActive = Number.isInteger(requestedLimit) ? Math.min(500, Math.max(1, requestedLimit)) : 200;
const active = new Map();
let runtime = null;
let queue = Promise.resolve();
let coreLogSink = () => {};
let coreLogLevel = 'warning';
const serialized = job => { const result = queue.then(job); queue = result.catch(() => {}); return result; };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function validate(input) {
  if (!input || typeof input.appId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(input.appId)) throw new Error('应用标识无效');
  if (typeof input.name !== 'string' || !input.name || input.name.length > 200) throw new Error('节点名称无效');
  if (typeof input.rawLine !== 'string' || input.rawLine.length > 8192 || !/^\s*-\s*\{.*\}\s*$/.test(input.rawLine) || /[\r\n\x00-\x1f]/.test(input.rawLine)) throw new Error('节点缺少 Clash 行内配置');
  if (!/\btype\s*:\s*["']?(ss|ssr|vmess|vless|trojan|anytls|hysteria|hysteria2|tuic|snell|wireguard|ssh)\b/i.test(input.rawLine)) throw new Error('此节点协议暂不支持本地转换');
  return { appId: input.appId, name: input.name, rawLine: input.rawLine.trim() };
}

async function freePort(reserved) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); });
    });
    if (!reserved.has(port)) { reserved.add(port); return port; }
  }
  throw new Error('无法分配空闲端口');
}

async function portAvailable(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

function renameProxy(line, name) {
  const pattern = /^(\s*-\s*\{\s*name\s*:\s*)(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^,}]*)(,)/;
  if (!pattern.test(line)) throw new Error('节点配置缺少可识别的 name 字段');
  return line.replace(pattern, (_, prefix, comma) => `${prefix}${JSON.stringify(name)}${comma}`);
}

function configText(entries) {
  const proxies = entries.map((entry, i) => `  ${renameProxy(entry.rawLine, `node-${i + 1}`)}`).join('\n');
  const listeners = entries.map((entry, i) => `  - name: ${JSON.stringify(entry.appId)}\n    type: mixed\n    port: ${entry.port}\n    listen: 127.0.0.1\n    proxy: ${JSON.stringify(`node-${i + 1}`)}\n    users:\n      - username: ${JSON.stringify(entry.username)}\n        password: ${JSON.stringify(entry.password)}`).join('\n');
  return `allow-lan: false\nbind-address: 127.0.0.1\nmode: rule\nlog-level: warning\nipv6: true\ndns:\n  enable: true\n  ipv6: true\n  enhanced-mode: redir-host\n  use-hosts: false\n  use-system-hosts: false\n  default-nameserver:\n    - 223.5.5.5\n    - 8.8.8.8\n  nameserver:\n    - https://doh.pub/dns-query\n    - https://dns.alidns.com/dns-query\n  proxy-server-nameserver:\n    - https://doh.pub/dns-query\n    - https://dns.alidns.com/dns-query\nproxies:\n${proxies}\nlisteners:\n${listeners}\nrules:\n  - MATCH,DIRECT\n`;
}

function configuredText(entries) {
  return configText(entries).replace('log-level: warning', `log-level: ${coreLogLevel}`);
}

async function portOpen(port) {
  return new Promise(resolve => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
  });
}

async function stopRuntime() {
  const old = runtime; runtime = null;
  if (!old) return;
  old.closed = true;
  for (const stream of old.streams || []) stream.destroy();
  for (const timer of old.timers || []) clearTimeout(timer);
  if (old.child.exitCode === null) {
    const exit = new Promise(resolve => old.child.once('exit', resolve));
    old.child.kill();
    await Promise.race([exit, delay(3000)]);
  }
  await rm(old.directory, { recursive: true, force: true });
}

async function launch(entries) {
  if (!entries.length) return null;
  const directory = await mkdtemp(join(tmpdir(), 'proxy-dispatcher-'));
  const config = join(directory, 'config.yaml');
  const controller = { port: await freePort(new Set(entries.map(entry => entry.port))), secret: randomBytes(32).toString('hex') };
  let child;
  try {
    const controllerConfig = `external-controller: 127.0.0.1:${controller.port}\nsecret: ${JSON.stringify(controller.secret)}\n`;
    await writeFile(config, controllerConfig + configuredText(entries), { encoding: 'utf8', mode: 0o600 });
    const checked = spawnSync(engine, ['-t', '-f', config], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
    if (checked.error || checked.status !== 0) throw new Error('节点配置未通过 Mihomo 校验');
    child = spawn(engine, ['-f', config], { windowsHide: true, stdio: 'ignore' });
    child.on('error', () => {});
    for (const entry of entries) {
      let ready = false;
      for (let n = 0; n < 45; n++) {
        if (child.exitCode !== null) throw new Error('Mihomo 启动后退出');
        if (await portOpen(entry.port)) { ready = true; break; }
        await delay(100);
      }
      if (!ready) throw new Error(`端口 ${entry.port} 未就绪`);
    }
    const session = { child, directory, controller, logLevel: coreLogLevel, closed: false, streams: [], timers: [], traffic: null, memory: null };
    watchCore(session, '/traffic', data => {
      if (Number.isFinite(data.up) && Number.isFinite(data.down)) session.traffic = {
        up: data.up, down: data.down, upTotal: data.upTotal, downTotal: data.downTotal, at: Date.now()
      };
    });
    watchCore(session, '/memory', data => {
      if (Number.isFinite(data.inuse)) session.memory = { inuse: data.inuse, at: Date.now() };
    });
    watchCore(session, `/logs?level=${session.logLevel}`, data => {
      if (['info', 'warning', 'error'].includes(data.type) && typeof data.payload === 'string') coreLogSink(data.type, data.payload);
    });
    return session;
  } catch (error) {
    if (child?.pid) child.kill();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function watchCore(session, path, onData) {
  const connect = () => {
    if (session.closed || session.child.exitCode !== null) return;
    const request = http.get({
      host: '127.0.0.1', port: session.controller.port, path,
      headers: { Authorization: `Bearer ${session.controller.secret}` },
      timeout: 5000
    }, response => {
      if (response.statusCode !== 200) { response.resume(); request.destroy(); return; }
      session.streams.push(response);
      let buffer = '';
      response.setTimeout(0);
      response.on('data', chunk => {
        buffer += chunk.toString('utf8');
        if (buffer.length > 65536) buffer = '';
        let boundary;
        while ((boundary = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, boundary).trim();
          buffer = buffer.slice(boundary + 1);
          if (line) { try { onData(JSON.parse(line)); } catch { /* Ignore malformed core frames. */ } }
        }
      });
      response.on('close', () => { session.streams = session.streams.filter(item => item !== response); });
    });
    session.streams.push(request);
    request.on('timeout', () => request.destroy());
    request.on('error', () => {});
    request.on('close', () => {
      session.streams = session.streams.filter(item => item !== request);
      if (!session.closed) session.timers.push(setTimeout(connect, 1000));
    });
  };
  connect();
}

export const setCoreLogSink = sink => { coreLogSink = sink; };
export const setCoreLogLevel = level => {
  if (!['error', 'warning', 'info'].includes(level)) throw new Error('内核日志级别无效');
  coreLogLevel = level;
};
export function getTelemetry() {
  const running = Boolean(runtime && runtime.child.exitCode === null);
  const current = running ? runtime : null;
  const recent = sample => sample && Date.now() - sample.at < 5000 ? sample : null;
  return {
    running, activeListeners: running ? active.size : 0,
    traffic: recent(current?.traffic), memory: recent(current?.memory),
    pid: current?.child.pid || null,
    coreLogLevel: current?.logLevel || coreLogLevel,
    pendingCoreLogLevel: coreLogLevel
  };
}

async function persist(entries) {
  await mkdir(dirname(activeFile), { recursive: true });
  const temp = `${activeFile}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify({ version: 1, entries }, null, 2), { encoding: 'utf8', mode: 0o600 });
  await rename(temp, activeFile);
}

async function replace(next) {
  const entries = [...next.values()];
  if (entries.length > maxActive) throw new Error(`最多同时启用 ${maxActive} 个节点，可设置 MAX_ACTIVE_NODES`);
  if (process.platform === 'win32' && !existsSync(engine)) throw new Error('未找到项目自带的 Mihomo，请恢复 vendor/mihomo/mihomo.exe 或设置 MIHOMO_PATH');
  const previous = [...active.values()];
  if (entries.length) {
    const directory = await mkdtemp(join(tmpdir(), 'proxy-dispatcher-check-'));
    try {
      const config = join(directory, 'config.yaml');
      await writeFile(config, configuredText(entries), { encoding: 'utf8', mode: 0o600 });
      const checked = spawnSync(engine, ['-t', '-f', config], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
      if (checked.error || checked.status !== 0) throw new Error('节点配置未通过 Mihomo 校验');
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  await stopRuntime();
  try {
    runtime = await launch(entries);
    active.clear();
    for (const entry of entries) active.set(entry.appId, entry);
    await persist(entries);
  } catch (error) {
    await stopRuntime();
    active.clear();
    for (const entry of previous) active.set(entry.appId, entry);
    try { runtime = await launch(previous); } catch (restoreError) { console.error('共享内核恢复失败:', restoreError.message); }
    throw error;
  }
}

const publicBridge = entry => ({ appId: entry.appId, name: entry.name, port: entry.port, username: entry.username, password: entry.password, pid: runtime?.child.pid ?? null, running: Boolean(runtime && runtime.child.exitCode === null) });
export const listBridges = () => [...active.values()].map(publicBridge);
export const getBridgeSnapshot = () => [...active.values()].map(entry => ({ ...entry }));

export function validateBridgeSnapshot(entries) {
  if (!Array.isArray(entries) || entries.length > maxActive) throw new Error('备份中的活动端口数量无效');
  const ids = new Set();
  const ports = new Set();
  return entries.map(entry => {
    const fields = validate(entry);
    if (!Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535 || ports.has(entry.port)) throw new Error('备份中的端口无效或重复');
    for (const value of [entry.username, entry.password]) {
      if (typeof value !== 'string' || !value || value.length > 128 || /[\r\n\x00-\x1f]/.test(value)) throw new Error('备份中的代理认证信息无效');
    }
    if (ids.has(fields.appId)) throw new Error('备份中的应用标识重复');
    ids.add(fields.appId);
    ports.add(entry.port);
    return { ...fields, port: entry.port, username: entry.username, password: entry.password };
  });
}

export const restoreBridgeSnapshot = entries => serialized(async () => {
  const validated = validateBridgeSnapshot(entries);
  await replace(new Map(validated.map(entry => [entry.appId, entry])));
  return { restored: validated.length };
});
export const restartBridges = () => serialized(async () => {
  const count = active.size;
  if (count) await replace(new Map(active));
  return { restarted: count };
});

export function startBridge(input) {
  return serialized(async () => {
    const fields = validate(input);
    const next = new Map(active);
    const old = next.get(fields.appId);
    const reserved = new Set([...next.values()].map(value => value.port));
    const entry = { ...fields, port: old?.port || await freePort(reserved), username: old?.username || `app${randomBytes(4).toString('hex')}`, password: old?.password || randomBytes(18).toString('base64url') };
    next.set(entry.appId, entry);
    await replace(next);
    return publicBridge(entry);
  });
}

export function stopBridge(appId) {
  return serialized(async () => {
    if (!active.has(appId)) return { stopped: false };
    const next = new Map(active); next.delete(appId);
    await replace(next);
    return { stopped: true };
  });
}

export function startBridgePool(items) {
  return serialized(async () => {
    if (!Array.isArray(items) || !items.length) throw new Error('没有可转换的协议节点');
    const next = new Map(active);
    const reserved = new Set([...active.values()].map(entry => entry.port));
    for (const item of items) {
      const fields = validate({ appId: `pool-${item.id}`, name: item.name, rawLine: item.rawLine });
      const old = active.get(fields.appId);
      const entry = { ...fields, port: old?.port || await freePort(reserved), username: old?.username || `pool${randomBytes(4).toString('hex')}`, password: old?.password || randomBytes(18).toString('base64url') };
      next.set(entry.appId, entry);
    }
    await replace(next);
    return { bridges: [...next.values()].filter(entry => entry.appId.startsWith('pool-')).map(publicBridge), failed: [] };
  });
}

export function stopBridgePool() {
  return serialized(async () => {
    const next = new Map([...active].filter(([id]) => !id.startsWith('pool-')));
    const stopped = active.size - next.size;
    if (stopped) await replace(next);
    return { stopped };
  });
}

export function stopAllBridges() {
  return serialized(async () => {
    const stopped = active.size;
    if (stopped) await replace(new Map());
    return { stopped };
  });
}

export function restoreBridges() {
  return serialized(async () => {
    if (!existsSync(activeFile)) return { restored: 0 };
    const data = JSON.parse(await readFile(activeFile, 'utf8'));
    if (!Array.isArray(data.entries)) throw new Error('活动节点存档格式错误');
    const entries = validateBridgeSnapshot(data.entries);
    const reserved = new Set(entries.map(entry => entry.port));
    let remapped = 0;
    for (const entry of entries) {
      if (await portAvailable(entry.port)) continue;
      entry.port = await freePort(reserved);
      remapped++;
    }
    runtime = await launch(entries);
    for (const entry of entries) active.set(entry.appId, entry);
    if (remapped) await persist(entries);
    return { restored: entries.length, remapped };
  });
}

export const shutdownBridges = () => serialized(stopRuntime);

export async function checkBridge(appId) {
  const bridge = active.get(appId);
  if (!bridge || !runtime || runtime.child.exitCode !== null) throw new Error('本地代理未运行');
  const localPortOpen = await portOpen(bridge.port);
  if (!localPortOpen) return { running: false, localPortOpen: false, upstreamReachable: false, error: '本地代理端口已关闭' };
  return new Promise(resolve => {
    const request = http.request({ host: '127.0.0.1', port: bridge.port, method: 'GET', path: 'http://www.gstatic.com/generate_204', headers: { Host: 'www.gstatic.com', 'Proxy-Authorization': `Basic ${Buffer.from(`${bridge.username}:${bridge.password}`).toString('base64')}` }, timeout: 10000 }, response => {
      response.resume();
      resolve({ running: true, localPortOpen: true, upstreamReachable: response.statusCode === 204, status: response.statusCode });
    });
    request.once('error', error => resolve({ running: true, localPortOpen: true, upstreamReachable: false, error: error.message }));
    request.once('timeout', () => { request.destroy(); resolve({ running: true, localPortOpen: true, upstreamReachable: false, error: '上游连接测试超时' }); });
    request.end();
  });
}
