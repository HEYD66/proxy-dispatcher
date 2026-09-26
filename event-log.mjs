import { appendFile, mkdir, readFile, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const file = process.env.EVENT_LOG_FILE || join(dirname(process.env.STATE_FILE || join(process.cwd(), 'data', 'state.json')), 'events.jsonl');
let writeQueue = Promise.resolve();

function safeMessage(value) {
  return String(value)
    .replace(/(?:https?|ss|ssr|vmess|vless|trojan|hysteria2?|tuic|socks5?):\/\/[^\s"'<>]+/gi, '[URL 已隐藏]')
    .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, 'Basic [凭据已隐藏]')
    .replace(/(?:token|password|passwd|secret|authorization|cookie|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '[敏感字段已隐藏]')
    .replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, '[标识已隐藏]')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 400);
}

export function logEvent(level, category, message) {
  const entry = {
    time: new Date().toISOString(),
    level: ['info', 'warning', 'error'].includes(level) ? level : 'info',
    category: String(category).slice(0, 24),
    message: safeMessage(message)
  };
  writeQueue = writeQueue.then(async () => {
    await mkdir(dirname(file), { recursive: true });
    try {
      if ((await stat(file)).size > 5 * 1024 * 1024) {
        await rename(file, `${file}.${Date.now()}.archive`);
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await appendFile(file, JSON.stringify(entry) + '\n', { encoding: 'utf8', mode: 0o600 });
  }).catch(error => console.error('事件日志写入失败:', error.message));
  return writeQueue;
}

export async function readEvents(limit = 200) {
  await writeQueue;
  let text;
  try { text = await readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const lines = text.trim().split('\n').slice(-Math.min(500, Math.max(1, Number(limit) || 200)));
  return lines.flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }).reverse();
}
