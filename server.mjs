import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBridge, stopBridge, listBridges, checkBridge, startBridgePool, stopBridgePool, stopAllBridges, restoreBridges, shutdownBridges } from './shared-bridge.mjs';
import { loadState, saveState } from './store.mjs';
import { probeProxy } from './proxy-probe.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const publicDir = join(root, 'public');
const port = Number(process.env.PORT || 4173);
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
let activeProbes = 0;

function probeError(error, proxy, bridge) {
  if (error?.code === 'ECONNRESET') return '代理链路连接被重置（ECONNRESET）；可能是上游节点、网络或探测目标，请先点“连通性”区分';
  if (error?.code === 'ECONNREFUSED') return '代理端口拒绝连接（ECONNREFUSED），请重新启用节点';
  if (error?.code === 'ETIMEDOUT') return '代理连接超时，请检查节点状态或更换节点';
  let message = String(error?.message || '代理探测失败');
  for (const secret of [proxy?.username, proxy?.password, bridge?.username, bridge?.password].filter(Boolean)) {
    message = message.replaceAll(secret, '[已隐藏]').replaceAll(encodeURIComponent(secret), '[已隐藏]');
  }
  return message.slice(0, 240);
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) { body += chunk; if (body.length > 8000000) throw new Error('请求过大'); }
  return JSON.parse(body || '{}');
}

async function fetchSubscription(url) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('只允许 http 或 https 订阅地址');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(parsed, { signal: controller.signal, redirect: 'follow', headers: { 'User-Agent': 'clash-verge/2.0', 'Accept': 'application/yaml, text/yaml, text/plain, */*' } });
    const text = await response.text();
    return { status: response.status, contentType: response.headers.get('content-type') || '', text };
  } finally { clearTimeout(timer); }
}

const server = http.createServer(async (req, res) => {
  try {
    const ownHost = `127.0.0.1:${port}`;
    if (req.headers.host !== ownHost || (req.headers.origin && req.headers.origin !== `http://${ownHost}`)) return send(res, 403, { error: '只允许本机同源访问' });
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    if (requestUrl.pathname === '/api/health') return send(res, 200, { ok: true, port });
    if (requestUrl.pathname === '/api/desktop/shutdown' && req.method === 'POST') {
      if (!process.env.DESKTOP_CONTROL_TOKEN || req.headers['x-desktop-token'] !== process.env.DESKTOP_CONTROL_TOKEN) return send(res, 403, { error: '无权关闭桌面服务' });
      send(res, 200, { stopping: true });
      setImmediate(async () => { server.close(); await shutdownBridges(); process.exit(0); });
      return;
    }
    if (requestUrl.pathname === '/api/state' && req.method === 'GET') return send(res, 200, await loadState());
    if (requestUrl.pathname === '/api/state' && req.method === 'PUT') return send(res, 200, await saveState(await readJson(req)));
    if (requestUrl.pathname === '/api/fetch') {
      const target = requestUrl.searchParams.get('url');
      if (!target) return send(res, 400, { error: '缺少 url 参数' });
      const result = await fetchSubscription(target);
      if (result.status < 200 || result.status >= 300) return send(res, 502, { error: `订阅返回 HTTP ${result.status}`, ...result });
      return send(res, 200, result);
    }
    if (requestUrl.pathname === '/api/bridges' && req.method === 'GET') return send(res, 200, { bridges: listBridges() });
    if (requestUrl.pathname === '/api/bridge/start' && req.method === 'POST') return send(res, 200, await startBridge(await readJson(req)));
    if (requestUrl.pathname === '/api/bridge/stop' && req.method === 'POST') return send(res, 200, await stopBridge((await readJson(req)).appId));
    if (requestUrl.pathname === '/api/bridge/check' && req.method === 'POST') return send(res, 200, await checkBridge((await readJson(req)).appId));
    if (requestUrl.pathname === '/api/proxy/probe' && req.method === 'POST') {
      const { id, kind } = await readJson(req);
      if (typeof id !== 'string' || id.length > 100 || !['ip', 'speed'].includes(kind)) return send(res, 400, { error: '探测参数无效' });
      if (activeProbes >= 10) return send(res, 429, { error: '同时最多测试 10 个节点' });
      const state = await loadState();
      const proxy = state.proxies.find(item => item.id === id);
      if (!proxy) return send(res, 404, { error: '节点不存在' });
      const bridges = listBridges();
      const bridge = bridges.find(item => item.appId === `pool-${id}`) || bridges.find(item => state.apps.some(app => app.id === item.appId && app.proxyId === id));
      activeProbes++;
      try { return send(res, 200, await probeProxy(proxy, bridge, kind)); }
      catch (error) {
        let message = probeError(error, proxy, bridge);
        if (bridge) {
          try {
            const check = await checkBridge(bridge.appId);
            if (!check.localPortOpen) message = '本地代理端口未运行，请重新启用节点';
            else if (!check.upstreamReachable) message = '本地端口正常，但节点连通性未通过' + (check.status ? '（HTTP ' + check.status + '）' : '') + '；请检查节点配置或更换节点';
            else if (error?.code === 'ECONNRESET') message = '节点基本连通，但出口 IP 探测连接被重置；请稍后重试或换用测速检查';
          } catch { /* Keep the original probe error when the follow-up check fails. */ }
        }
        return send(res, 502, { error: message });
      }
      finally { activeProbes--; }
    }
    if (requestUrl.pathname === '/api/bridge/pool/start' && req.method === 'POST') return send(res, 200, await startBridgePool((await readJson(req)).items));
    if (requestUrl.pathname === '/api/bridge/pool/stop' && req.method === 'POST') return send(res, 200, await stopBridgePool());
    if (requestUrl.pathname === '/api/bridge/stop-all' && req.method === 'POST') return send(res, 200, await stopAllBridges());
    const pathname = requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname;
    const file = normalize(join(publicDir, pathname));
    if (!file.startsWith(publicDir) || !existsSync(file)) return send(res, 404, { error: 'Not found' });
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch (error) {
    send(res, 500, { error: error.name === 'AbortError' ? '订阅请求超时' : error.message });
  }
});

try {
  const restored = await restoreBridges();
  if (restored.restored) console.log(`Restored ${restored.restored} active listeners in one Mihomo process`);
} catch (error) {
  console.error(`Active listener restore failed: ${error.message}`);
}
server.listen(port, '127.0.0.1', () => console.log(`Proxy Dispatcher running at http://127.0.0.1:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  server.close();
  await shutdownBridges();
  process.exit(0);
});
