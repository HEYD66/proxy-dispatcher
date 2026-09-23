import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBridge, stopBridge, listBridges, checkBridge, startBridgePool, stopBridgePool } from './bridge.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const publicDir = join(root, 'public');
const port = Number(process.env.PORT || 4173);
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) { body += chunk; if (body.length > 256000) throw new Error('请求过大'); }
  return JSON.parse(body || '{}');
}

async function fetchSubscription(url) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('只允许 http 或 https 订阅地址');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(parsed, { signal: controller.signal, redirect: 'follow', headers: { 'User-Agent': 'ProxyDispatcher/1.0' } });
    const text = await response.text();
    return { status: response.status, contentType: response.headers.get('content-type') || '', text };
  } finally { clearTimeout(timer); }
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    if (requestUrl.pathname === '/api/health') return send(res, 200, { ok: true, port });
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
    if (requestUrl.pathname === '/api/bridge/pool/start' && req.method === 'POST') return send(res, 200, await startBridgePool((await readJson(req)).items));
    if (requestUrl.pathname === '/api/bridge/pool/stop' && req.method === 'POST') return send(res, 200, await stopBridgePool());
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

server.listen(port, '127.0.0.1', () => console.log(`Proxy Dispatcher running at http://127.0.0.1:${port}`));
