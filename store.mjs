import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const file = process.env.STATE_FILE || join(root, 'data', 'state.json');
const empty = () => ({ version: 1, sources: [], proxies: [], apps: [] });
let writeQueue = Promise.resolve();

export async function loadState() {
  if (!existsSync(file)) return empty();
  const data = JSON.parse(await readFile(file, 'utf8'));
  return normalize(data);
}

function normalize(data) {
  if (!data || !Array.isArray(data.sources) || !Array.isArray(data.proxies) || !Array.isArray(data.apps)) throw new Error('保存的数据格式错误');
  if (data.sources.length > 1000 || data.proxies.length > 100000 || data.apps.length > 10000) throw new Error('保存的数据超过限制');
  return { version: 1, sources: data.sources, proxies: data.proxies, apps: data.apps };
}
export const validateState = normalize;

export function saveState(data) {
  const snapshot = normalize(data);
  const operation = writeQueue.then(async () => {
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(snapshot), { encoding: 'utf8', mode: 0o600 });
    if (existsSync(file)) await copyFile(file, `${file}.bak`);
    await rename(temporary, file);
    return { saved: true, sources: snapshot.sources.length, proxies: snapshot.proxies.length, apps: snapshot.apps.length };
  });
  writeQueue = operation.catch(() => {});
  return operation;
}
