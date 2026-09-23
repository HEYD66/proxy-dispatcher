import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const engine = process.env.MIHOMO_PATH || 'D:\\Clash Verge\\verge-mihomo.exe';
const bridges = new Map();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function validate(input) {
  if (!input || typeof input.appId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(input.appId)) throw new Error('应用标识无效');
  if (typeof input.rawLine !== 'string' || input.rawLine.length > 8192 || !/^\s*-\s*\{.*\}\s*$/.test(input.rawLine) || /[\r\n\x00-\x1f]/.test(input.rawLine)) throw new Error('此节点缺少可用的 Clash 配置，请先重新解析订阅');
  if (!/\btype\s*:\s*(ss|vmess|vless|trojan)\b/i.test(input.rawLine)) throw new Error('当前仅支持 Clash 格式的 SS、VMess、VLESS 和 Trojan 节点');
  if (typeof input.name !== 'string' || !input.name || input.name.length > 200) throw new Error('节点名称无效');
  return { appId: input.appId, rawLine: input.rawLine.trim(), name: input.name };
}

function configText(line, name, port, username, password) {
  return `mixed-port: ${port}\nallow-lan: false\nbind-address: 127.0.0.1\nmode: rule\nlog-level: warning\nauthentication:\n  - ${JSON.stringify(`${username}:${password}`)}\nproxies:\n  ${line}\nproxy-groups:\n  - name: ROUTE\n    type: select\n    proxies:\n      - ${JSON.stringify(name)}\nrules:\n  - MATCH,ROUTE\n`;
}

async function waitForPort(port, child) {
  for (let attempt = 0; attempt < 35; attempt++) {
    if (child.exitCode !== null) throw new Error('Mihomo 启动后退出');
    const ready = await new Promise(resolve => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
      socket.setTimeout(300, () => { socket.destroy(); resolve(false); });
    });
    if (ready) return;
    await delay(100);
  }
  throw new Error('本地代理端口未就绪');
}

export async function startBridge(input) {
  const { appId, rawLine, name } = validate(input);
  if (!existsSync(engine)) throw new Error('未找到 Mihomo 内核，请确认 Clash Verge 安装在 D:\\Clash Verge');
  await stopBridge(appId);
  const port = await freePort();
  const username = `app${randomBytes(4).toString('hex')}`;
  const password = randomBytes(18).toString('base64url');
  const directory = await mkdtemp(join(tmpdir(), 'proxy-dispatcher-'));
  const config = join(directory, 'config.yaml');
  await writeFile(config, configText(rawLine, name, port, username, password), { encoding: 'utf8', mode: 0o600 });
  let child;
  try {
    const check = spawnSync(engine, ['-t', '-f', config], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
    if (check.status !== 0) throw new Error('节点配置未通过 Mihomo 校验');
    child = spawn(engine, ['-f', config], { windowsHide: true, stdio: 'ignore' });
    child.on('error', () => {});
    await waitForPort(port, child);
    const bridge = { appId, port, username, password, pid: child.pid, child, name };
    bridges.set(appId, bridge);
    child.once('exit', () => { if (bridges.get(appId) === bridge) bridges.delete(appId); });
    return publicBridge(bridge);
  } catch (error) {
    if (child?.pid) child.kill();
    throw error;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function publicBridge(bridge) {
  return { appId: bridge.appId, port: bridge.port, username: bridge.username, password: bridge.password, name: bridge.name, running: bridge.child.exitCode === null };
}

export function listBridges() { return [...bridges.values()].map(publicBridge); }

export async function stopBridge(appId) {
  const bridge = bridges.get(appId);
  if (!bridge) return { stopped: false };
  bridges.delete(appId);
  bridge.child.kill();
  return { stopped: true };
}

export async function checkBridge(appId) {
  const bridge = bridges.get(appId);
  if (!bridge || bridge.child.exitCode !== null) throw new Error('本地代理未运行');
  const localPortOpen = await new Promise(resolve => {
    const socket = net.connect(bridge.port, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.setTimeout(800, () => { socket.destroy(); resolve(false); });
  });
  if (!localPortOpen) return { running: false, localPortOpen: false, upstreamReachable: false, error: '本地代理端口已关闭' };
  return new Promise(resolve => {
    const request = http.request('http://www.gstatic.com/generate_204', {
      host: '127.0.0.1', port: bridge.port, method: 'GET', path: 'http://www.gstatic.com/generate_204',
      headers: { 'Proxy-Authorization': `Basic ${Buffer.from(`${bridge.username}:${bridge.password}`).toString('base64')}` }, timeout: 10000,
    }, response => { response.resume(); resolve({ running: true, localPortOpen: true, upstreamReachable: response.statusCode === 204, status: response.statusCode }); });
    request.once('error', error => resolve({ running: true, localPortOpen: true, upstreamReachable: false, error: error.message }));
    request.once('timeout', () => { request.destroy(); resolve({ running: true, localPortOpen: true, upstreamReachable: false, error: '上游连接测试超时' }); });
    request.end();
  });
}
