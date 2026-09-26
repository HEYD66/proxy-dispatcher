import https from 'node:https';
import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

const ipUrl = 'https://api64.ipify.org?format=json';
const latencyUrl = 'https://speed.cloudflare.com/__down?bytes=0';
const downloadBytes = 2_000_000;
const downloadUrl = `https://speed.cloudflare.com/__down?bytes=${downloadBytes}`;

function proxyAgent(proxy, bridge) {
  if (bridge) {
    if (!bridge.running) throw new Error('本地代理端口未运行');
    const address = `http://${encodeURIComponent(bridge.username)}:${encodeURIComponent(bridge.password)}@127.0.0.1:${bridge.port}`;
    return new HttpsProxyAgent(address);
  }
  const protocol = String(proxy.protocol || '').toLowerCase();
  if (['ss', 'vmess', 'vless', 'trojan'].includes(protocol)) throw new Error('请先启用该加密节点');
  if (!['http', 'https', 'socks', 'socks5'].includes(protocol)) throw new Error('此代理协议不支持直接测试');
  const port = Number(proxy.port);
  if (!proxy.server || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('代理地址或端口无效');
  const host = String(proxy.server).includes(':') && !String(proxy.server).startsWith('[') ? `[${proxy.server}]` : proxy.server;
  const user = proxy.username ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password || '')}@` : '';
  const scheme = ['socks', 'socks5'].includes(protocol) ? 'socks5h' : protocol;
  const address = `${scheme}://${user}${host}:${port}`;
  return scheme === 'socks5h' ? new SocksProxyAgent(address) : new HttpsProxyAgent(address);
}

function requestViaProxy(url, agent, limit, timeoutMs) {
  return new Promise((resolve, reject) => {
    let finished = false;
    let timer;
    const started = performance.now();
    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const request = https.get(url, {
      agent,
      headers: { 'Accept-Encoding': 'identity', 'Cache-Control': 'no-cache', 'User-Agent': 'ProxyDispatcher/1.0' }
    }, response => {
      const latencyMs = performance.now() - started;
      if (response.statusCode !== 200) {
        finish(new Error(`探测服务返回 HTTP ${response.statusCode}`));
        response.destroy();
        return;
      }
      let bytes = 0;
      const chunks = [];
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > limit) {
          finish(new Error('探测响应超过大小限制'));
          response.destroy();
          return;
        }
        if (limit < 10000) chunks.push(chunk);
      });
      response.once('error', finish);
      response.once('end', () => finish(null, {
        bytes,
        latencyMs,
        durationMs: performance.now() - started,
        body: limit < 10000 ? Buffer.concat(chunks).toString('utf8') : undefined
      }));
    });
    request.once('error', finish);
    timer = setTimeout(() => request.destroy(new Error('探测超时')), timeoutMs);
  });
}

async function lookupIp(agent) {
  const response = await requestViaProxy(ipUrl, agent, 4096, 15000);
  let ip;
  try { ip = JSON.parse(response.body).ip; } catch { throw new Error('出口 IP 服务返回内容无效'); }
  if (typeof ip !== 'string' || !isIP(ip)) throw new Error('出口 IP 服务未返回有效地址');
  return { ip, latencyMs: Math.round(response.latencyMs) };
}

async function lookupIpWithStartupRetry(agent) {
  try { return await lookupIp(agent); }
  catch (error) {
    if (!['ECONNRESET', 'ECONNREFUSED', 'EPIPE'].includes(error.code)) throw error;
    await new Promise(resolve => setTimeout(resolve, 1000));
    return lookupIp(agent);
  }
}

export async function probeProxy(proxy, bridge, kind) {
  if (!['ip', 'speed'].includes(kind)) throw new Error('未知探测类型');
  const agent = proxyAgent(proxy, bridge);
  try {
    if (kind === 'ip') {
      return { ...await lookupIpWithStartupRetry(agent), checkedAt: new Date().toISOString() };
    }
    const { ip } = await lookupIpWithStartupRetry(agent);
    const latency = await requestViaProxy(latencyUrl, agent, 4096, 15000);
    const download = await requestViaProxy(downloadUrl, agent, downloadBytes + 65536, 25000);
    if (download.bytes < downloadBytes) throw new Error('下载测速数据不完整');
    return {
      ip,
      latencyMs: Math.round(latency.latencyMs),
      downloadMbps: Math.round(download.bytes * 8 / Math.max(download.durationMs, 1) / 1000 * 100) / 100,
      bytes: download.bytes,
      checkedAt: new Date().toISOString()
    };
  } finally { agent.destroy(); }
}
