import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const file = process.env.EVENT_LOG_FILE || join(dirname(process.env.STATE_FILE || join(process.cwd(), 'data', 'state.json')), 'events.jsonl');
let writeQueue = Promise.resolve();
let retentionDays = 0;
export const setLogRetentionDays = days => { retentionDays = days; };

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

export function pruneOldEvents() {
  const operation = writeQueue.then(async () => {
    if (!retentionDays) return { removed: 0 };
    const cutoff = Date.now() - retentionDays * 86400000;
    let removed = 0;
    const folder = dirname(file);
    const prefix = `${basename(file)}.`;
    for (const name of await readdir(folder).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error))) {
      if (!name.startsWith(prefix) || !name.endsWith('.archive')) continue;
      const path = join(folder, name);
      if ((await stat(path)).mtimeMs < cutoff) { await rm(path); removed++; }
    }
    let contents;
    try { contents = await readFile(file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return { removed }; throw error; }
    const lines = contents.split('\n').filter(Boolean);
    const kept = lines.filter(line => {
      try { const time = Date.parse(JSON.parse(line).time); return !Number.isFinite(time) || time >= cutoff; }
      catch { return true; }
    });
    removed += lines.length - kept.length;
    if (kept.length !== lines.length) {
      const temporary = `${file}.${process.pid}.tmp`;
      await writeFile(temporary, kept.length ? kept.join('\n') + '\n' : '', { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, file);
    }
    return { removed };
  });
  writeQueue = operation.catch(error => console.error('日志保留清理失败:', error.message));
  return operation;
}
