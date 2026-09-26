import electronPath from 'electron';
import { cp, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('此脚本只打包 Windows x64 版本');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
const output = join(root, 'dist', `ProxyDispatcher-${manifest.version}-win32-x64`);
const source = dirname(electronPath);
if (!existsSync(join(source, 'electron.exe'))) throw new Error('Electron 运行时未安装，请先运行 npm.cmd install');
if (!existsSync(join(root, 'vendor', 'mihomo', 'mihomo.exe'))) throw new Error('缺少自带 Mihomo 内核');
await mkdir(join(root, 'dist'), { recursive: true });
if (existsSync(output)) {
  const backup = `${output}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  await rename(output, backup);
  process.stdout.write(`已备份上次打包产物：${backup}\n`);
}
await cp(source, output, { recursive: true });
const appDir = join(output, 'resources', 'app');
await mkdir(appDir, { recursive: true });
for (const name of ['electron-main.mjs', 'server.mjs', 'shared-bridge.mjs', 'event-log.mjs', 'settings-store.mjs', 'store.mjs', 'proxy-probe.mjs', 'README.md']) {
  await cp(join(root, name), join(appDir, name));
}
await cp(join(root, 'public'), join(appDir, 'public'), { recursive: true });
await cp(join(root, 'assets'), join(appDir, 'assets'), { recursive: true });
await cp(join(root, 'vendor', 'mihomo'), join(appDir, 'vendor', 'mihomo'), { recursive: true });
for (const [name, details] of Object.entries(lock.packages)) {
  if (!name.startsWith('node_modules/') || details.dev) continue;
  const destination = join(appDir, name);
  await mkdir(dirname(destination), { recursive: true });
  await cp(join(root, name), destination, { recursive: true });
}
await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: manifest.name, productName: '代理分发器', version: manifest.version, type: 'module', main: 'electron-main.mjs', dependencies: manifest.dependencies }, null, 2));
await rename(join(output, 'electron.exe'), join(output, 'Proxy Dispatcher.exe'));
process.stdout.write(`${output}\n`);
