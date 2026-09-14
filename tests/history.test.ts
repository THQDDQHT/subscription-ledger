/** 续费历史：实付金额、记录时间、历史列表、撤销与旧库/旧备份兼容。移植自 tests/test_history.py。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { hashPassword } from '@/server/auth';
import { resetStateForTests } from '@/server/db';
import { TestClient, post } from './helpers';
import { item } from './domain.test';

const PASSWORD_HASH = hashPassword('test-password-123');
const RENEW = { actual_date: '2024-01-31', next_date: '2024-02-29', confirm: true };

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

async function createItem(): Promise<string> {
  const res = await post(client, '/api/items', item({ amount: '12.30' }));
  return ((await res.json()) as { id: string }).id;
}

async function renewals(ident: string): Promise<Array<Record<string, unknown>>> {
  return (await client.json(`/api/items/${ident}/renewals`)) as Array<Record<string, unknown>>;
}

test('续费记录实付金额与记录时间', async () => {
  const ident = await createItem();
  const res = await post(client, `/api/items/${ident}/renew`, RENEW);
  expect(res.status).toBe(200);
  const renewalId = ((await res.json()) as { renewal_id: string }).renewal_id;
  expect(renewalId).toBeTruthy();
  let history = await renewals(ident);
  expect(history).toHaveLength(1);
  expect(history[0].id).toBe(renewalId);
  expect(history[0].amount_cents).toBe(1230);
  expect(history[0].amount).toBe('12.30'); // 默认取当前每期金额
  expect((history[0].recorded_at as string).endsWith('+08:00')).toBe(true);
  expect(history[0].undoable).toBe(true);
  expect(history[0].previous_date).toBe('2024-01-31');
  expect(history[0].next_date).toBe('2024-02-29');
  // 显式实付金额只进历史，不改订阅本身的金额。
  expect((await post(client, `/api/items/${ident}/renew`, { actual_date: '2024-02-29', next_date: '2024-03-31', amount: '30.5', confirm: true })).status).toBe(200);
  history = await renewals(ident);
  expect(history.map((h) => h.amount)).toEqual(['30.50', '12.30']);
  expect(history.map((h) => h.undoable)).toEqual([true, false]);
  expect((await client.json('/api/items') as Array<{ amount: string }>)[0].amount).toBe('12.30');
  for (const bad of ['abc', '1.234', '-1', 12, '']) {
    expect((await post(client, `/api/items/${ident}/renew`, { actual_date: '2024-03-31', next_date: '2024-04-30', amount: bad, confirm: true })).status).toBe(400);
  }
  expect(await renewals(ident)).toHaveLength(2);
});

test('只能撤销最近一次续费，且锚点保持', async () => {
  const ident = await createItem();
  const first = ((await (await post(client, `/api/items/${ident}/renew`, RENEW)).json()) as { renewal_id: string }).renewal_id;
  const second = ((await (await post(client, `/api/items/${ident}/renew`, { actual_date: '2024-02-29', next_date: '2024-03-31', confirm: true })).json()) as { renewal_id: string }).renewal_id;
  const undo = (rid: string, body: unknown = { confirm: true }) => post(client, `/api/items/${ident}/renewals/${rid}/undo`, body);
  expect((await undo(second, { confirm: false })).status).toBe(400);
  const notLatest = await undo(first);
  expect(notLatest.status).toBe(400);
  expect(((await notLatest.json()) as { error: string }).error).toContain('最近一次');
  expect((await undo('0'.repeat(32))).status).toBe(404);
  expect((await post(client, `/api/items/${'0'.repeat(32)}/renewals/${second}/undo`, { confirm: true })).status).toBe(404);
  const res = await undo(second);
  expect(res.status).toBe(200);
  expect(((await res.json()) as { next_date: string }).next_date).toBe('2024-02-29');
  expect((await client.json('/api/items') as Array<{ next_date: string }>)[0].next_date).toBe('2024-02-29');
  expect((await undo(first)).status).toBe(200);
  const row = (await client.json('/api/items') as Array<{ next_date: string; suggested_next: string; amount: string; status: string }>)[0];
  expect(row.next_date).toBe('2024-01-31');
  expect(row.suggested_next).toBe('2024-02-29'); // 月底锚点未被撤销破坏
  expect(row.amount).toBe('12.30');
  expect(row.status).toBe('active');
  expect(await renewals(ident)).toEqual([]);
  expect((await undo(second)).status).toBe(404);
});

test('计划日期被编辑后拒绝撤销；已取消状态仍可撤销', async () => {
  const ident = await createItem();
  const rid = ((await (await post(client, `/api/items/${ident}/renew`, RENEW)).json()) as { renewal_id: string }).renewal_id;
  expect((await post(client, `/api/items/${ident}`, item({ next_date: '2024-03-15' }), 'put')).status).toBe(200);
  const history = await renewals(ident);
  expect(history[0].undoable).toBe(false);
  const res = await post(client, `/api/items/${ident}/renewals/${rid}/undo`, { confirm: true });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toContain('已被修改');
  expect((await client.json('/api/items') as Array<{ next_date: string }>)[0].next_date).toBe('2024-03-15');
  // 撤销不要求状态为使用中：改成已取消后仍能撤回记录错误的续费。
  expect((await post(client, `/api/items/${ident}`, item({ next_date: '2024-02-29', status: 'cancelled' }), 'put')).status).toBe(200);
  expect((await post(client, `/api/items/${ident}/renewals/${rid}/undo`, { confirm: true })).status).toBe(200);
  expect((await client.json('/api/items') as Array<{ next_date: string }>)[0].next_date).toBe('2024-01-31');
});

test('备份往返、旧备份无金额兼容与非法字段拒绝', async () => {
  const ident = await createItem();
  await post(client, `/api/items/${ident}/renew`, { ...RENEW, amount: '99.99' });
  const backup = (await (await client.get('/api/export')).json()) as { renewals: Array<Record<string, unknown>>; items: unknown[] };
  const entry = backup.renewals[0];
  expect(entry.amount_cents).toBe(9999);
  expect(entry.amount).toBe('99.99');
  expect(entry.recorded_at).toBeTruthy();
  expect((await post(client, '/api/restore', { confirm: true, backup })).status).toBe(200);
  expect(await (await client.get('/api/export')).json()).toEqual(backup);
  expect((await renewals(ident))[0].amount).toBe('99.99');
  // 旧版本导出的历史没有金额与时间：恢复后显示为未记录，而不是用当前金额冒充。
  const legacy = JSON.parse(JSON.stringify(backup));
  for (const key of ['amount_cents', 'amount', 'recorded_at']) delete legacy.renewals[0][key];
  expect((await post(client, '/api/restore', { confirm: true, backup: legacy })).status).toBe(200);
  const restored = (await renewals(ident))[0];
  expect(restored.amount_cents).toBeNull();
  expect(restored.amount).toBeNull();
  expect(restored.recorded_at).toBeNull();
  expect(restored.undoable).toBe(true);
  const exported = (await (await client.get('/api/export')).json()) as { renewals: Array<Record<string, unknown>> };
  expect(exported.renewals[0].amount_cents).toBeNull();
  // 恢复以 amount_cents 为准，忽略展示用的 amount 字符串。
  const skewed = JSON.parse(JSON.stringify(backup));
  skewed.renewals[0].amount = '1.00';
  expect((await post(client, '/api/restore', { confirm: true, backup: skewed })).status).toBe(200);
  expect((await renewals(ident))[0].amount).toBe('99.99');
  for (const [key, value] of [
    ['amount_cents', true], ['amount_cents', -1], ['amount_cents', '9999'], ['amount_cents', 10 ** 10],
    ['recorded_at', '昨天'], ['recorded_at', 123], ['recorded_at', 'x'.repeat(41)],
  ] as const) {
    const bad = JSON.parse(JSON.stringify(backup));
    bad.renewals[0][key] = value;
    expect((await post(client, '/api/restore', { confirm: true, backup: bad })).status, `${key}=${String(value)}`).toBe(400);
    const unchanged = (await (await client.get('/api/export')).json()) as { renewals: Array<Record<string, unknown>> };
    expect(unchanged.renewals[0].amount).toBe('99.99');
  }
});

test('旧库自动迁移（幂等）与无时间戳记录的排序/撤销', async () => {
  // 独立数据目录：beforeEach 已在新 schema 下建过库，旧库场景需要干净目录。
  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-legacy-'));
  process.env.LEDGER_DATA_DIR = legacyDir;
  try {
    const file = path.join(legacyDir, 'ledger.sqlite3');
    const seed = new Database(file);
    seed.exec(`
    CREATE TABLE subscriptions (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE renewals (id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL, actual_date TEXT NOT NULL, previous_date TEXT NOT NULL, next_date TEXT NOT NULL);
    CREATE TABLE attempts (ip TEXT PRIMARY KEY, count INTEGER NOT NULL, start REAL NOT NULL);
  `);
    const payload = { name: '旧记录', amount: '12.30', amount_cents: 1230, cycle: 'monthly', days: null, next_date: '2024-02-29', auto_renew: true, status: 'active', end_date: null, url: '', notes: '', anchor_day: 31, anchor_month: 1 };
    seed.prepare('INSERT INTO subscriptions VALUES (?,?)').run('a'.repeat(32), JSON.stringify(payload));
    seed.prepare('INSERT INTO renewals VALUES (?,?,?,?,?)').run('b'.repeat(32), 'a'.repeat(32), '2024-01-31', '2024-01-31', '2024-02-29');
    seed.close();
    // 迁移必须幂等：关闭缓存连接后重开两次。
    for (let i = 0; i < 2; i += 1) {
      resetStateForTests();
      const c = new TestClient();
      await c.login();
      expect((await c.get('/api/session')).status).toBe(200);
    }
    resetStateForTests();
    const check = new Database(file, { readonly: true });
    const columns = new Set((check.prepare('PRAGMA table_info(renewals)').all() as Array<{ name: string }>).map((r) => r.name));
    check.close();
    expect(columns.has('amount_cents')).toBe(true);
    expect(columns.has('recorded_at')).toBe(true);
    const c = new TestClient();
    await c.login();
    let history = (await c.json(`/api/items/${'a'.repeat(32)}/renewals`)) as Array<Record<string, unknown>>;
    expect(history).toEqual([{
      id: 'b'.repeat(32), subscription_id: 'a'.repeat(32), actual_date: '2024-01-31',
      previous_date: '2024-01-31', next_date: '2024-02-29',
      amount_cents: null, amount: null, recorded_at: null, undoable: true,
    }]);
    // 新记录排在无时间戳的旧记录前面，旧记录仍可在轮到它时撤销。
    await post(c, `/api/items/${'a'.repeat(32)}/renew`, { actual_date: '2024-02-29', next_date: '2024-03-31', confirm: true });
    history = (await c.json(`/api/items/${'a'.repeat(32)}/renewals`)) as Array<Record<string, unknown>>;
    expect(history.map((h) => h.recorded_at === null)).toEqual([false, true]);
    expect(history[0].undoable).toBe(true);
    expect(history[1].undoable).toBe(false);
    expect((await post(c, `/api/items/${'a'.repeat(32)}/renewals/${history[0].id as string}/undo`, { confirm: true })).status).toBe(200);
    expect((await post(c, `/api/items/${'a'.repeat(32)}/renewals/${'b'.repeat(32)}/undo`, { confirm: true })).status).toBe(200);
    expect((await c.json('/api/items') as Array<{ next_date: string }>)[0].next_date).toBe('2024-01-31');
  } finally {
    resetStateForTests();
    fs.rmSync(legacyDir, { recursive: true, force: true });
  }
});
