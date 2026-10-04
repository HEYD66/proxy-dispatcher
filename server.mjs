import http from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { startBridge, stopBridge, listBridges, checkBridge, startBridgePool, stopBridgePool, stopAllBridges, restoreBridges, shutdownBridges, getTelemetry, setCoreLogSink, setCoreLogLevel, getBridgeSnapshot, validateBridgeSnapshot, restoreBridgeSnapshot, restartBridges } from './shared-bridge.mjs';
import { loadState, saveState, validateState } from './store.mjs';
import { probeProxy } from './proxy-probe.mjs';
import { logEvent, readEvents, setLogRetentionDays, pruneOldEvents } from './event-log.mjs';
import { loadSettings, saveSettings, validateSettings, settingsFile } from './settings-store.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const publicDir = join(root, 'public');
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';
const serverMode = process.env.SERVER_MODE === '1';
if (serverMode && !['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('SERVER_MODE 下管理服务必须绑定回环地址，请使用 Nginx 或其他反向代理对外提供访问');
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
let activeProbes = 0;
let currentSettings;
try { currentSettings = await loadSettings(); }
catch (error) { console.error('设置读取失败，使用默认值:', error.message); currentSettings = validateSettings({}); }
setCoreLogLevel(currentSettings.coreLogLevel);
setLogRetentionDays(currentSettings.logRetentionDays);
setCoreLogSink((level, message) => logEvent(level, 'Mihomo', message));
const desktopRequests = new Map();
let desktopRequestId = 0;
const rateBuckets = new Map();
const mutationMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function clientAddress(req) {
  const forwarded = String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || 'unknown';
}

function rateLimit(req, pathname) {
  if (!serverMode || !pathname.startsWith('/api/')) return null;
  const now = Date.now();
  const windowMs = 60_000;
  const limit = pathname === '/api/fetch' ? 30 : 180;
  const key = `${clientAddress(req)}|${pathname === '/api/fetch' ? 'fetch' : 'api'}`;
  const previous = rateBuckets.get(key);
  if (!previous || now - previous.startedAt >= windowMs) {
    rateBuckets.set(key, { startedAt: now, count: 1 });
  } else {
    previous.count += 1;
    if (previous.count > limit) return Math.ceil((windowMs - (now - previous.startedAt)) / 1000);
  }
  if (rateBuckets.size > 10000) {
    for (const [bucketKey, bucket] of rateBuckets) if (now - bucket.startedAt >= windowMs) rateBuckets.delete(bucketKey);
  }
  return null;
}

function requireBrowserMutation(req, pathname) {
  return serverMode && pathname.startsWith('/api/') && mutationMethods.has(req.method) && req.headers['x-requested-with'] !== 'ProxyDispatcher';
}

process.on('message', message => {
  if (message?.type !== 'settings-applied') return;
  const pending = desktopRequests.get(message.requestId);
  if (!pending) return;
  desktopRequests.delete(message.requestId);
  clearTimeout(pending.timer);
  if (message.error) pending.reject(new Error(message.error));
  else pending.resolve();
});

function applyDesktopSettings(next) {
  if (!process.send) {
    if (next.autoStart !== currentSettings.autoStart || next.closeBehavior !== currentSettings.closeBehavior) throw new Error('开机自启和托盘设置仅桌面版可用');
    return Promise.resolve();
  }
  const requestId = ++desktopRequestId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { desktopRequests.delete(requestId); reject(new Error('桌面设置同步超时')); }, 5000);
    desktopRequests.set(requestId, { resolve, reject, timer });
    process.send({ type: 'apply-settings', requestId, settings: next });
  });
}

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
    const ownHost = `${host}:${port}`;
    if (!serverMode && (req.headers.host !== ownHost || (req.headers.origin && req.headers.origin !== `http://${ownHost}`))) return send(res, 403, { error: '只允许本机同源访问' });
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    const retryAfter = rateLimit(req, requestUrl.pathname);
    if (retryAfter) {
      res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': String(retryAfter) });
      res.end(JSON.stringify({ error: '请求过于频繁，请稍后再试' }));
      return;
    }
    if (requireBrowserMutation(req, requestUrl.pathname)) return send(res, 403, { error: '缺少受信任的浏览器请求头' });
    if (requestUrl.pathname === '/api/health') return send(res, 200, { ok: true, port });
    if (requestUrl.pathname === '/api/desktop/shutdown' && req.method === 'POST') {
      if (!process.env.DESKTOP_CONTROL_TOKEN || req.headers['x-desktop-token'] !== process.env.DESKTOP_CONTROL_TOKEN) return send(res, 403, { error: '无权关闭桌面服务' });
      send(res, 200, { stopping: true });
      setImmediate(async () => { server.close(); await shutdownBridges(); process.exit(0); });
      return;
    }
    if (requestUrl.pathname === '/api/state' && req.method === 'GET') return send(res, 200, await loadState());
    if (requestUrl.pathname === '/api/state' && req.method === 'PUT') return send(res, 200, await saveState(await readJson(req)));
    if (requestUrl.pathname === '/api/settings' && req.method === 'GET') {
      const core = process.env.MIHOMO_PATH || (process.platform === 'win32' ? join(root, 'vendor', 'mihomo', 'mihomo.exe') : 'mihomo');
      const version = spawnSync(core, ['-v'], { windowsHide: true, encoding: 'utf8', timeout: 3000 });
      return send(res, 200, {
        settings: currentSettings,
        serverMode,
        desktopAvailable: Boolean(process.send),
        coreVersion: (version.stdout || '').trim().split(/\r?\n/)[0] || '无法读取',
        dataDirectory: dirname(settingsFile),
        logFile: join(dirname(settingsFile), 'events.jsonl'),
        runtime: getTelemetry()
      });
    }
    if (requestUrl.pathname === '/api/settings' && req.method === 'PUT') {
      const next = validateSettings({ ...currentSettings, ...await readJson(req) });
      const previous = currentSettings;
      await applyDesktopSettings(next);
      try { await saveSettings(next); }
      catch (error) { await applyDesktopSettings(previous).catch(() => {}); throw error; }
      currentSettings = next;
      setCoreLogLevel(next.coreLogLevel);
      setLogRetentionDays(next.logRetentionDays);
      let retentionWarning = null;
      if (next.logRetentionDays) {
        try { await pruneOldEvents(); }
        catch (error) { retentionWarning = '设置已保存，但旧日志清理失败；下次启动会重试'; console.error('旧日志清理失败:', error.message); }
      }
      await logEvent('info', '设置', '设置已保存');
      return send(res, 200, { settings: next, pendingCoreRestart: getTelemetry().coreLogLevel !== next.coreLogLevel, retentionWarning });
    }
    if (requestUrl.pathname === '/api/backup' && req.method === 'GET') {
      return send(res, 200, { type: 'proxy-dispatcher-backup', version: 1, createdAt: new Date().toISOString(), state: await loadState(), activeBridges: getBridgeSnapshot() });
    }
    if (requestUrl.pathname === '/api/backup/restore' && req.method === 'POST') {
      const backup = await readJson(req);
      if (backup?.type !== 'proxy-dispatcher-backup' || backup.version !== 1) return send(res, 400, { error: '不是受支持的代理分发器备份文件' });
      const nextState = validateState(backup.state);
      const nextBridges = validateBridgeSnapshot(backup.activeBridges);
      const previousState = await loadState();
      const previousBridges = getBridgeSnapshot();
      const safetyDir = join(dirname(settingsFile), 'restore-backups');
      await mkdir(safetyDir, { recursive: true });
      const safetyFile = join(safetyDir, `before-restore-${Date.now()}.json`);
      await writeFile(safetyFile, JSON.stringify({ type: 'proxy-dispatcher-backup', version: 1, createdAt: new Date().toISOString(), state: previousState, activeBridges: previousBridges }), { encoding: 'utf8', mode: 0o600 });
      await restoreBridgeSnapshot(nextBridges);
      try { await saveState(nextState); }
      catch (error) {
        await restoreBridgeSnapshot(previousBridges).catch(restoreError => console.error('恢复旧端口失败:', restoreError.message));
        await saveState(previousState).catch(restoreError => console.error('恢复旧状态失败:', restoreError.message));
        throw error;
      }
      await logEvent('warning', '数据', `已从备份恢复 ${nextState.sources.length} 个订阅、${nextState.proxies.length} 个节点和 ${nextBridges.length} 个端口`);
      return send(res, 200, { restored: true, sources: nextState.sources.length, proxies: nextState.proxies.length, activeListeners: nextBridges.length, safetyFile });
    }
    if (requestUrl.pathname === '/api/telemetry' && req.method === 'GET') return send(res, 200, getTelemetry());
    if (requestUrl.pathname === '/api/logs' && req.method === 'GET') return send(res, 200, { events: await readEvents(requestUrl.searchParams.get('limit')) });
    if (requestUrl.pathname === '/api/fetch') {
      const target = requestUrl.searchParams.get('url');
      if (!target) return send(res, 400, { error: '缺少 url 参数' });
      const result = await fetchSubscription(target);
      await logEvent(result.status >= 200 && result.status < 300 ? 'info' : 'warning', '订阅', `订阅请求返回 HTTP ${result.status}`);
      if (result.status < 200 || result.status >= 300) return send(res, 502, { error: `订阅返回 HTTP ${result.status}`, ...result });
      return send(res, 200, result);
    }
    if (requestUrl.pathname === '/api/bridges' && req.method === 'GET') return send(res, 200, { bridges: listBridges() });
    if (requestUrl.pathname === '/api/bridge/start' && req.method === 'POST') {
      const result = await startBridge(await readJson(req));
      await logEvent('info', '代理', '已启用一个应用代理端口');
      return send(res, 200, result);
    }
    if (requestUrl.pathname === '/api/bridge/stop' && req.method === 'POST') {
      const result = await stopBridge((await readJson(req)).appId);
      if (result.stopped) await logEvent('info', '代理', '已停用一个应用代理端口');
      return send(res, 200, result);
    }
    if (requestUrl.pathname === '/api/bridge/check' && req.method === 'POST') {
      const result = await checkBridge((await readJson(req)).appId);
      await logEvent(result.upstreamReachable ? 'info' : 'warning', '连通性', result.upstreamReachable ? '节点连通性通过' : '节点连通性未通过');
      return send(res, 200, result);
    }
    if (requestUrl.pathname === '/api/proxy/probe' && req.method === 'POST') {
      const { id, kind } = await readJson(req);
      if (typeof id !== 'string' || id.length > 100 || !['ip', 'speed'].includes(kind)) return send(res, 400, { error: '探测参数无效' });
      if (activeProbes >= 10) return send(res, 429, { error: '同时最多测试 10 个节点' });
      const state = await loadState();
      const proxy = state.proxies.find(item => item.id === id);
      if (!proxy) return send(res, 404, { error: '节点不存在' });
      const nodeNumber = state.proxies.indexOf(proxy) + 1;
      const bridges = listBridges();
      const bridge = bridges.find(item => item.appId === `pool-${id}`) || bridges.find(item => state.apps.some(app => app.id === item.appId && app.proxyId === id));
      activeProbes++;
      try {
        const result = await probeProxy(proxy, bridge, kind, currentSettings.probeTimeoutSeconds * 1000);
        await logEvent('info', '检测', `第 ${nodeNumber} 个节点${kind === 'ip' ? '出口 IP 检测' : '测速'}成功`);
        return send(res, 200, result);
      }
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
        await logEvent('warning', '检测', `第 ${nodeNumber} 个节点${kind === 'ip' ? '出口 IP 检测' : '测速'}失败：${message}`);
        return send(res, 502, { error: message });
      }
      finally { activeProbes--; }
    }
    if (requestUrl.pathname === '/api/bridge/pool/start' && req.method === 'POST') {
      const result = await startBridgePool((await readJson(req)).items);
      await logEvent('info', '代理', `共享内核代理池已启用 ${result.bridges.length} 个端口`);
      return send(res, 200, result);
    }
    if (requestUrl.pathname === '/api/bridge/pool/stop' && req.method === 'POST') {
      const result = await stopBridgePool();
      await logEvent('info', '代理', `代理池已停用 ${result.stopped} 个端口`);
      return send(res, 200, result);
    }
    if (requestUrl.pathname === '/api/bridge/restart' && req.method === 'POST') {
      const result = await restartBridges();
      await logEvent('warning', '代理', `共享内核已重启，恢复 ${result.restarted} 个端口`);
      return send(res, 200, result);
    }
    if (requestUrl.pathname === '/api/bridge/stop-all' && req.method === 'POST') {
      const result = await stopAllBridges();
      await logEvent('warning', '代理', `已停用全部 ${result.stopped} 个端口`);
      return send(res, 200, result);
    }
    const pathname = requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname;
    const file = normalize(join(publicDir, pathname));
    if (!file.startsWith(publicDir) || !existsSync(file)) return send(res, 404, { error: 'Not found' });
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch (error) {
    if (req.url?.startsWith('/api/') && !req.url.startsWith('/api/logs') && !req.url.startsWith('/api/telemetry')) logEvent('error', '服务', `请求失败：${error?.code || error?.name || 'Error'}`);
    send(res, 500, { error: error.name === 'AbortError' ? '订阅请求超时' : error.message });
  }
});

try {
  if (currentSettings.logRetentionDays) await pruneOldEvents();
  const restored = currentSettings.restoreOnLaunch ? await restoreBridges() : { restored: 0 };
  if (restored.restored) console.log(`Restored ${restored.restored} active listeners in one Mihomo process${restored.remapped ? `; reassigned ${restored.remapped} occupied ports` : ''}`);
  await logEvent('info', '启动', currentSettings.restoreOnLaunch ? `本机服务启动，恢复 ${restored.restored} 个代理端口${restored.remapped ? `，其中 ${restored.remapped} 个端口因占用重新分配` : ''}` : '本机服务启动，已跳过活动端口恢复');
} catch (error) {
  console.error(`Active listener restore failed: ${error.message}`);
  await logEvent('error', '启动', '活动代理端口恢复失败');
}
server.listen(port, host, () => console.log(`Proxy Dispatcher running at http://${host}:${port}${serverMode ? ' [server mode]' : ''}`));
const retentionTimer = setInterval(() => { if (currentSettings.logRetentionDays) pruneOldEvents().catch(() => {}); }, 86400000);
retentionTimer.unref();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  server.close();
  await shutdownBridges();
  process.exit(0);
});
