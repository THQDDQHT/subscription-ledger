/** API 行为规格：移植自 tests/test_ledger.py 的接口用例。 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest';
import { hashPassword, readSessionFrom, sessionSecret } from '@/server/auth';
import { handleApi } from '@/server/api';
import { TestClient, post } from './helpers';
import { item } from './domain.test';

const PASSWORD_HASH = hashPassword('test-password-123');

let dir: string;
let client: TestClient;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
  process.env.LEDGER_DATA_DIR = dir;
  process.env.LEDGER_TEST_PASSWORD_HASH = PASSWORD_HASH;
  client = new TestClient();
  await client.login();
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.LEDGER_DATA_DIR;
  delete process.env.LEDGER_TEST_PASSWORD_HASH;
});

describe('鉴权与 CSRF', () => {
  test('登录 Cookie 和服务端会话均固定有效 30 天，访问不续期，到期立即拒绝', async () => {
    const start = Math.floor(Date.now() / 1000) * 1000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
    const login = await client.post('/api/login', { password: 'test-password-123' });
    expect(login.status).toBe(200);
    const cookie = login.headers.getSetCookie().join(';');
    expect(cookie).toContain('Max-Age=2592000');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    const session = readSessionFrom(new Request('http://test.local', { headers: { Cookie: cookie.split(';')[0] } }));
    expect(session?.exp).toBe(start / 1000 + 2592000);
    for (const elapsed of [13 * 3600 * 1000, 29 * 86400000, 30 * 86400000 - 1]) {
      clock.mockReturnValue(start + elapsed);
      const response = await client.get('/api/items');
      expect(response.status).toBe(200);
      expect(response.headers.has('Set-Cookie')).toBe(false);
    }
    clock.mockReturnValue(start + 30 * 86400000);
    expect((await client.get('/api/items')).status).toBe(401);
    expect(await client.json('/api/session')).toMatchObject({ authenticated: false });
  });

  test('主动退出立即清除一个月的登录 Cookie', async () => {
    const response = await client.post('/api/logout', {});
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie().join(';')).toContain('Max-Age=0');
    expect((await client.get('/api/items')).status).toBe(401);
  });

  test('旧的 12 小时凭证保留原到期时间', async () => {
    const start = Math.floor(Date.now() / 1000) * 1000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
    // 按旧版本格式签发，确保升级不会延长已存在的签名凭证。
    const payload = Buffer.from(JSON.stringify({ authenticated: true, csrf: 'legacy-csrf', exp: start / 1000 + 12 * 3600 })).toString('base64url');
    const signature = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
    const request = () => new Request('http://test.local/api/items', { headers: { Cookie: `ledger_session=${payload}.${signature}` } });
    expect((await handleApi(request())).status).toBe(200);
    clock.mockReturnValue(start + 12 * 3600 * 1000);
    expect((await handleApi(request())).status).toBe(401);
  });

  test('未登录 401、缺 CSRF 403、Cookie 属性、错误密码限速', async () => {
    const anon = new TestClient();
    for (const url of ['/api/items', '/api/export', '/api/summary']) {
      expect((await anon.get(url)).status).toBe(401);
    }
    // 已登录但缺 CSRF 头 → 403
    expect((await client.request('POST', '/api/items', item(), false)).status).toBe(403);
    // 非法管理链接 → 400
    expect((await post(client, '/api/items', item({ url: 'file:///etc/passwd' }))).status).toBe(400);
    // 会话 Cookie 属性
    const cookie = (await anon.get('/api/session')).headers.getSetCookie().join(';');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    // 限速：同一窗口 5 次错误后第 6 次 429
    const session = (await (await anon.get('/api/session')).json()) as { csrf: string };
    anon.token = session.csrf;
    for (let i = 0; i < 5; i += 1) {
      expect((await anon.post('/api/login', { password: 'wrong' })).status).toBe(401);
    }
    const blocked = await anon.post('/api/login', { password: 'wrong' });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBeTruthy();
  });
});

describe('CRUD、续费与持久化', () => {
  test('新增、续费、编辑状态、删除与重启持久化', async () => {
    const res = await post(client, '/api/items', item());
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string };
    const ident = created.id;
    expect((await post(client, `/api/items/${ident}/renew`, { actual_date: '2024-01-31', next_date: '2024-02-29', confirm: true })).status).toBe(200);
    const items = (await client.json('/api/items')) as Array<{ next_date: string; suggested_next: string }>;
    expect(items[0].next_date).toBe('2024-02-29');
    expect(items[0].suggested_next).toBe('2024-03-31');
    expect((await post(client, `/api/items/${ident}`, item({ next_date: '2024-02-29', status: 'cancelled', end_date: '2024-03-01' }), 'put')).status).toBe(200);
    // 已取消状态不能确认续费
    expect((await post(client, `/api/items/${ident}/renew`, { actual_date: '2024-02-29', next_date: '2024-03-31', confirm: true })).status).toBe(400);
    // 模拟重启：新客户端读同一数据目录，记录仍在
    const fresh = new TestClient();
    await fresh.login();
    expect((await fresh.json('/api/items') as unknown[]).length).toBe(1);
    // 删除需要明确确认
    expect((await post(client, `/api/items/${ident}`, {}, 'delete')).status).toBe(400);
    expect((await post(client, `/api/items/${ident}`, { confirm: true }, 'delete')).status).toBe(200);
    expect(await client.json('/api/items')).toEqual([]);
  });
});

describe('备份与恢复', () => {
  test.each([
    [{ cycle: 'semiannual' }, '2024-08-31', '2025-02-28', '2025-08-31'],
    [{ cycle: 'months', months: 2 }, '2024-12-31', '2025-02-28', '2025-04-30'],
    [{ cycle: 'years', years: 2 }, '2024-02-29', '2026-02-28', '2028-02-29'],
  ])('新周期新增、续费、编辑、持久化及备份往返：%o', async (patch, start, next, afterNext) => {
    const response = await post(client, '/api/items', item({ ...patch, next_date: start }));
    expect(response.status).toBe(201);
    const { id } = await response.json() as { id: string };
    expect((await client.json('/api/items') as Array<Record<string, unknown>>)[0].suggested_next).toBe(next);
    expect((await post(client, `/api/items/${id}/renew`, { actual_date: start, next_date: next, confirm: true })).status).toBe(200);
    let row = (await client.json('/api/items') as Array<Record<string, unknown>>)[0];
    expect(row.suggested_next).toBe(afterNext);
    expect(row).toMatchObject(patch);
    expect((await post(client, `/api/items/${id}`, { ...row, amount: '24.00' }, 'put')).status).toBe(200);
    const original = await client.json('/api/export');
    expect((await post(client, '/api/restore', { confirm: true, backup: original })).status).toBe(200);
    expect(await client.json('/api/export')).toEqual(original);
    const fresh = new TestClient();
    await fresh.login();
    row = (await fresh.json('/api/items') as Array<Record<string, unknown>>)[0];
    expect(row).toMatchObject({ ...patch, amount: '24.00', suggested_next: afterNext });
    const history = await fresh.json(`/api/items/${id}/renewals`) as Array<{ id: string }>;
    expect((await post(fresh, `/api/items/${id}/renewals/${history[0].id}/undo`, { confirm: true })).status).toBe(200);
    expect((await fresh.json('/api/items') as Array<Record<string, unknown>>)[0]).toMatchObject({ ...patch, next_date: start, suggested_next: next });
  });

  test('非法自定义月数/年数在新增、编辑与恢复时均拒绝且保留原数据', async () => {
    const created = await post(client, '/api/items', item({ cycle: 'months', months: 2 }));
    const { id } = await created.json() as { id: string };
    const original = await client.json('/api/export') as { items: Array<Record<string, unknown>> };
    for (const patch of [{ cycle: 'months', months: 0 }, { cycle: 'years', years: 1.5 }, { cycle: 'years', years: '2' }]) {
      expect((await post(client, '/api/items', item(patch))).status).toBe(400);
      expect((await post(client, `/api/items/${id}`, item(patch), 'put')).status).toBe(400);
      const bad = { ...original, items: [{ ...original.items[0], ...patch }] };
      expect((await post(client, '/api/restore', { confirm: true, backup: bad })).status).toBe(400);
      expect(await client.json('/api/export')).toEqual(original);
    }
  });

  test('导出不泄露密码、恢复校验与备份文件生成', async () => {
    await post(client, '/api/items', item());
    const original = (await (await client.get('/api/export')).json()) as { items: Array<Record<string, unknown>> };
    expect(JSON.stringify(original).toLowerCase()).not.toContain('password');
    expect((await post(client, '/api/restore', { confirm: false, backup: original })).status).toBe(400);
    const bad = JSON.parse(JSON.stringify(original));
    bad.items.push({ ...bad.items[0], amount: 'bad' });
    expect((await post(client, '/api/restore', { confirm: true, backup: bad })).status).toBe(400);
    expect(await (await client.get('/api/export')).json()).toEqual(original);
    expect((await post(client, '/api/restore', { confirm: true, backup: original })).status).toBe(200);
    const backups = fs.readdirSync(path.join(dir, 'backups')).filter((f) => f.endsWith('.sqlite3'));
    expect(backups).toHaveLength(1);
    expect(await (await client.get('/api/export')).json()).toEqual(original);
  });

  test('季付自定义确认、导出恢复与非法周期拒绝', async () => {
    const created = await post(client, '/api/items', item({ cycle: 'quarterly' }));
    expect(created.status).toBe(201);
    const ident = ((await created.json()) as { id: string }).id;
    expect((await client.json('/api/items') as Array<{ suggested_next: string }>)[0].suggested_next).toBe('2024-04-30');
    expect((await post(client, `/api/items/${ident}/renew`, { actual_date: '2024-01-31', next_date: '2024-05-15', confirm: true })).status).toBe(200);
    const row = (await client.json('/api/items') as Array<{ anchor_day: number; suggested_next: string }>)[0];
    expect(row.anchor_day).toBe(31);
    expect(row.suggested_next).toBe('2024-08-31');
    await post(client, '/api/items', item({ cycle: 'monthly' }));
    const original = (await (await client.get('/api/export')).json()) as { version: number; items: Array<Record<string, unknown>> };
    expect(original.version).toBe(1);
    expect((await post(client, '/api/restore', { confirm: true, backup: original })).status).toBe(200);
    expect(await (await client.get('/api/export')).json()).toEqual(original);
    const restored = (await client.json('/api/items') as Array<{ id: string; suggested_next: string }>).find((r) => r.id === ident);
    expect(restored?.suggested_next).toBe('2024-08-31');
    const invalid = { ...original, items: [{ ...original.items[0], cycle: 'quarter' }] };
    expect((await post(client, '/api/restore', { confirm: true, backup: invalid })).status).toBe(400);
    expect(await (await client.get('/api/export')).json()).toEqual(original);
  });
});
