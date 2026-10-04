import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
const output = join(root, 'dist', `ProxyDispatcher-${manifest.version}-linux`);
if (existsSync(output)) throw new Error('Linux 产物目录已存在，请先备份或选择新的版本号');
await mkdir(output, { recursive: true });
for (const name of ['server.mjs', 'shared-bridge.mjs', 'event-log.mjs', 'settings-store.mjs', 'store.mjs', 'proxy-probe.mjs', 'README.md', 'public', 'deploy']) {
  await cp(join(root, name), join(output, name), { recursive: true });
}
for (const [name, details] of Object.entries(lock.packages)) {
  if (!name.startsWith('node_modules/') || details.dev) continue;
  await mkdir(dirname(join(output, name)), { recursive: true });
  await cp(join(root, name), join(output, name), { recursive: true });
}
await mkdir(join(output, 'vendor', 'mihomo'), { recursive: true });
await cp(join(root, 'vendor', 'mihomo', 'LICENSE'), join(output, 'vendor', 'mihomo', 'LICENSE'));
await writeFile(join(output, 'package.json'), JSON.stringify({ name: manifest.name, version: manifest.version, private: true, type: 'module', scripts: { start: 'node server.mjs' }, dependencies: manifest.dependencies }, null, 2));
process.stdout.write(output + '\n');
