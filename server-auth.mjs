import { randomBytes, scrypt as scryptCallback, createHash, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile, mkdir, writeFile, rename, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const scrypt = promisify(scryptCallback);
const hashToken = token => createHash('sha256').update(token).digest('hex');
const loopback = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
const forwarded = req => ['x-forwarded-proto', 'x-forwarded-for', 'x-real-ip', 'x-forwarded-host'].some(name => req.headers[name] !== undefined);
const PASSWORD_OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

// All sessions are revoked on process restart. The disk contains only a salted password hash.
export async function createServerAuth({ file, port, tunnelPort = 17473, publicOrigin = '', now = Date.now, idleMs = 30 * 60_000, lifetimeMs = 12 * 60 * 60_000 }) {
  let credential = null;
  let busy = 0;
  let settingUp = false;
  const sessions = new Map();
  const failures = new Map();
  let attempts = { start: now(), count: 0 };
  const directHosts = new Set([port, tunnelPort].flatMap(value => [`127.0.0.1:${value}`, `localhost:${value}`, `[::1]:${value}`]));
  const origins = new Set(publicOrigin.split(',').map(value => value.trim()).filter(Boolean));
  for (const origin of origins) {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'https:' || parsed.origin !== origin) throw new Error('PUBLIC_ORIGIN 必须是完整的 HTTPS 源地址，不含路径');
  }
  try {
    credential = JSON.parse(await readFile(file, 'utf8'));
    if (credential.version !== 1 || credential.kdf !== 'scrypt' || !/^[a-f0-9]{32}$/.test(credential.salt) || !/^[a-f0-9]{128}$/.test(credential.hash)) throw new Error('管理账号哈希文件无效');
    await chmod(file, 0o600);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }

  function checkRequest(req) {
    if (!loopback(req.socket.remoteAddress)) return false;
    if (req.headers['sec-fetch-site'] === 'cross-site' && (req.method !== 'GET' || req.headers['sec-fetch-mode'] !== 'navigate')) return false;
    if (forwarded(req)) {
      if (req.headers['x-forwarded-proto'] !== 'https') return false;
      return !req.headers.origin || origins.has(req.headers.origin);
    }
    if (!directHosts.has(req.headers.host)) return false;
    return !req.headers.origin || req.headers.origin === `http://${req.headers.host}`;
  }

  function canSetup(req) {
    return !credential && !forwarded(req) && checkRequest(req);
  }

  function session(req, touch = false) {
    const token = String(req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith('pd_session='))?.slice(11);
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    const key = hashToken(token);
    const value = sessions.get(key);
    if (!value) return null;
    if (now() >= value.expires || now() - value.lastSeen >= idleMs) { sessions.delete(key); return null; }
    if (touch) value.lastSeen = now();
    return { key, ...value };
  }

  function cookie(req, token, age) {
    return `pd_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${forwarded(req) ? '; Secure' : ''}`;
  }

  function issue(req, res) {
    for (const [key, value] of sessions) if (now() >= value.expires || now() - value.lastSeen >= idleMs) sessions.delete(key);
    if (sessions.size >= 100) sessions.delete(sessions.keys().next().value);
    const token = randomBytes(32).toString('hex');
    sessions.set(hashToken(token), { expires: now() + lifetimeMs, lastSeen: now() });
    res.setHeader('Set-Cookie', cookie(req, token, Math.floor(lifetimeMs / 1000)));
  }

  async function derive(password, salt) {
    if (busy >= 2) throw Object.assign(new Error('登录请求繁忙，请稍后重试'), { status: 429 });
    busy++;
    try { return await scrypt(password, salt, 64, PASSWORD_OPTIONS); }
    finally { busy--; }
  }

  function validatePassword(password) {
    if (typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password, 'utf8') > 256) throw Object.assign(new Error('密码至少 12 个字符，最多 256 字节'), { status: 400 });
  }

  async function savePassword(password) {
    validatePassword(password);
    const salt = randomBytes(16).toString('hex');
    const hash = (await derive(password, salt)).toString('hex');
    const next = { version: 1, kdf: 'scrypt', salt, hash };
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = join(dirname(file), `.auth-${randomBytes(8).toString('hex')}.tmp`);
    await writeFile(temporary, JSON.stringify(next) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
    await chmod(file, 0o600);
    credential = next;
    sessions.clear();
  }

  function limit(key) {
    const time = now();
    for (const [ip, value] of failures) if (time - value.start >= 15 * 60_000) failures.delete(ip);
    const value = failures.get(key);
    if (value?.count >= 5) return Math.ceil((15 * 60_000 - (time - value.start)) / 1000);
    if (time - attempts.start >= 60_000) attempts = { start: time, count: 0 };
    if (attempts.count >= 30 || busy >= 2) return 60;
    attempts.count++;
    return 0;
  }

  function fail(key) {
    if (!failures.has(key)) {
      if (failures.size >= 1000) failures.delete(failures.keys().next().value);
      failures.set(key, { start: now(), count: 0 });
    }
    failures.get(key).count++;
  }

  async function verify(password) {
    if (!credential || typeof password !== 'string' || Buffer.byteLength(password, 'utf8') > 256) return false;
    const hash = await derive(password, credential.salt);
    return timingSafeEqual(hash, Buffer.from(credential.hash, 'hex'));
  }

  return {
    checkRequest, canSetup, session,
    status: req => ({ serverMode: true, configured: Boolean(credential), authenticated: Boolean(session(req)), canSetup: canSetup(req), idleMinutes: idleMs / 60_000 }),
    async setup(req, res, password) {
      if (!canSetup(req) || settingUp) throw Object.assign(new Error('首次设置只能通过 SSH 隧道进行，且只能创建一次'), { status: 403 });
      settingUp = true;
      try { await savePassword(password); issue(req, res); }
      finally { settingUp = false; }
    },
    async login(req, res, body, key) {
      const retryAfter = limit(key);
      if (retryAfter) throw Object.assign(new Error('登录尝试过于频繁，请稍后重试'), { status: 429, retryAfter });
      const valid = await verify(body.password);
      if (body.username !== 'admin' || !valid) { fail(key); throw Object.assign(new Error('账号或密码错误'), { status: 401 }); }
      failures.delete(key);
      issue(req, res);
    },
    logout(req, res) {
      const current = session(req);
      if (current) sessions.delete(current.key);
      res.setHeader('Set-Cookie', cookie(req, '', 0));
    },
    async changePassword(req, res, body, key) {
      const retryAfter = limit(key);
      if (retryAfter) throw Object.assign(new Error('密码验证过于频繁，请稍后重试'), { status: 429, retryAfter });
      if (!await verify(body.currentPassword)) { fail(key); throw Object.assign(new Error('当前密码错误'), { status: 400 }); }
      await savePassword(body.newPassword);
      failures.delete(key);
      issue(req, res);
    }
  };
}
