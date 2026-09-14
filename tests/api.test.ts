/** API 行为规格：移植自 tests/test_ledger.py 的接口用例。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { hashPassword } from '@/server/auth';
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
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.LEDGER_DATA_DIR;
  delete process.env.LEDGER_TEST_PASSWORD_HASH;
});

describe('鉴权与 CSRF', () => {
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
