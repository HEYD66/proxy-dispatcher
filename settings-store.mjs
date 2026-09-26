import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
export const settingsFile = process.env.SETTINGS_FILE || join(dirname(process.env.STATE_FILE || join(root, 'data', 'state.json')), 'settings.json');
export const defaults = Object.freeze({
  restoreOnLaunch: true,
  closeBehavior: 'quit',
  autoStart: false,
  startupPage: 'overview',
  probeConcurrency: 5,
  probeTimeoutSeconds: 15,
  coreLogLevel: 'warning',
  logRetentionDays: 0
});
let writeQueue = Promise.resolve();

export function validateSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('设置格式无效');
  const result = { ...defaults, ...input };
  for (const key of ['restoreOnLaunch', 'autoStart']) {
    if (typeof result[key] !== 'boolean') throw new Error(`${key} 必须是开关`);
  }
  if (!['quit', 'tray'].includes(result.closeBehavior)) throw new Error('关闭行为无效');
  if (!['overview', 'sources', 'proxies', 'apps', 'logs', 'settings'].includes(result.startupPage)) throw new Error('启动页面无效');
  if (![3, 5, 8].includes(result.probeConcurrency)) throw new Error('检测并发数无效');
  if (![10, 15, 20, 30, 60].includes(result.probeTimeoutSeconds)) throw new Error('检测超时时间无效');
  if (!['error', 'warning', 'info'].includes(result.coreLogLevel)) throw new Error('内核日志级别无效');
  if (![0, 7, 30, 90].includes(result.logRetentionDays)) throw new Error('日志保留时间无效');
  return Object.fromEntries(Object.keys(defaults).map(key => [key, result[key]]));
}

export async function loadSettings(file = settingsFile) {
  if (!existsSync(file)) return { ...defaults };
  return validateSettings(JSON.parse(await readFile(file, 'utf8')));
}

export function saveSettings(input, file = settingsFile) {
  const next = validateSettings(input);
  const operation = writeQueue.then(async () => {
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
    if (existsSync(file)) await copyFile(file, `${file}.bak`);
    await rename(temporary, file);
    return next;
  });
  writeQueue = operation.catch(() => {});
  return operation;
}
