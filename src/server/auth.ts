/** 密码哈希（werkzeug 格式兼容）、签名会话 Cookie、登录限速。 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dataRoot } from './db';

const SALT_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** 生成 werkzeug 风格哈希：scrypt:<n>:<r>:<p>$<salt>$<hex>，dklen=64。 */
export function hashPassword(password: string): string {
  const n = 32768;
  const r = 8;
  const p = 1;
  const salt = Array.from(crypto.randomBytes(16), (b) => SALT_ALPHABET[b % SALT_ALPHABET.length]).join('');
  const hex = crypto.scryptSync(password, salt, 64, { N: n, r, p, maxmem: 132 * n * r * p }).toString('hex');
  return `scrypt:${n}:${r}:${p}$${salt}$${hex}`;
}

/** 兼容 werkzeug 的 scrypt 与 pbkdf2 格式，可直接读取旧 Python 版保存的 password.hash。 */
export function checkPassword(stored: string, supplied: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3) return false;
  const [method, salt, expectedHex] = parts;
  const expected = Buffer.from(expectedHex, 'hex');
  let actual: Buffer;
  if (method.startsWith('scrypt:')) {
    const [n, r, p] = method.slice('scrypt:'.length).split(':').map(Number);
    if (!n || !r || !p) return false;
    actual = crypto.scryptSync(supplied, salt, expected.length, { N: n, r, p, maxmem: 132 * n * r * p });
  } else if (method.startsWith('pbkdf2:')) {
    const [, hashName, iterations] = method.split(':');
    const rounds = Number(iterations);
    if ((hashName !== 'sha256' && hashName !== 'sha512') || !rounds) return false;
    actual = crypto.pbkdf2Sync(supplied, salt, rounds, expected.length, hashName);
  } else {
    return false;
  }
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

/** 测试钩子（对应 Flask 的 PASSWORD_HASH 配置）：设置后优先于 data/password.hash。 */
export function passwordHash(): string | null {
  const override = process.env.LEDGER_TEST_PASSWORD_HASH;
  if (override) return override;
  const file = path.join(dataRoot(), 'password.hash');
  return fs.existsSync(/* turbopackIgnore: true */ file) ? fs.readFileSync(/* turbopackIgnore: true */ file, 'utf8').trim() : null;
}

export function writePasswordHash(hash: string): void {
  const root = dataRoot();
  const temp = path.join(root, 'password.hash.tmp');
  const fd = fs.openSync(/* turbopackIgnore: true */ temp, 'w', 0o600);
  fs.writeSync(fd, hash);
  fs.closeSync(fd);
  fs.renameSync(/* turbopackIgnore: true */ temp, path.join(root, 'password.hash'));
}

let cachedSecret: { dir: string; value: string } | null = null;

/** 会话签名密钥，复用 data/session.key（0600），与 Python 版同一文件。 */
export function sessionSecret(): string {
  const root = dataRoot();
  if (cachedSecret && cachedSecret.dir === root) return cachedSecret.value;
  const file = path.join(root, 'session.key');
  let value: string;
  try {
    const fd = fs.openSync(/* turbopackIgnore: true */ file, 'wx', 0o600);
    value = crypto.randomBytes(32).toString('hex');
    fs.writeSync(fd, value);
    fs.closeSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    value = fs.readFileSync(/* turbopackIgnore: true */ file, 'utf8').trim();
  }
  cachedSecret = { dir: root, value };
  return value;
}

export function rotateSessionSecret(): void {
  const root = dataRoot();
  const value = crypto.randomBytes(32).toString('hex');
  const fd = fs.openSync(/* turbopackIgnore: true */ path.join(root, 'session.key'), 'w', 0o600);
  fs.writeSync(fd, value);
  fs.closeSync(fd);
  cachedSecret = { dir: root, value };
}

const SESSION_COOKIE = 'ledger_session';
// 从登录时起固定有效 30 天，访问页面不会续期。
export const SESSION_TTL_SECONDS = 30 * 24 * 3600;

export interface SessionData {
  authenticated: boolean;
  csrf: string;
  exp: number;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
}

export function encodeSession(data: Omit<SessionData, 'exp'>): string {
  const payload = base64url(JSON.stringify({ ...data, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS }));
  return `${payload}.${sign(payload)}`;
}

export function decodeSession(value: string | undefined): SessionData | null {
  if (!value) return null;
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = value.slice(0, dot);
  const signature = value.slice(dot + 1);
  const expected = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (typeof data.csrf !== 'string' || typeof data.exp !== 'number') return null;
    if (data.exp * 1000 <= Date.now()) return null;
    return { authenticated: data.authenticated === true, csrf: data.csrf, exp: data.exp };
  } catch {
    return null;
  }
}

function cookieFlags(): string {
  const secure = process.env.LEDGER_COOKIE_SECURE === '1' ? '; Secure' : '';
  return `; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_SECONDS}${secure}`;
}

export function sessionSetCookie(data: Omit<SessionData, 'exp'>): string {
  return `${SESSION_COOKIE}=${encodeSession(data)}${cookieFlags()}`;
}

export function sessionClearCookie(): string {
  const secure = process.env.LEDGER_COOKIE_SECURE === '1' ? '; Secure' : '';
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`;
}

export function readSessionFrom(req: Request): SessionData | null {
  const header = req.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === SESSION_COOKIE) {
      return decodeSession(part.slice(index + 1).trim());
    }
  }
  return null;
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
