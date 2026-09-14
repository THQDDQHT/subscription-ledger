/** 恢复健壮性与事务回滚。移植自 tests/test_extra.py 的接口用例。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
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

test('恢复保留锚点与历史，拒绝重复/坏锚点/坏引用/错币种', async () => {
  const res = await post(client, '/api/items', item());
  const ident = ((await res.json()) as { id: string }).id;
  expect((await post(client, `/api/items/${ident}/renew`, { actual_date: '2024-01-31', next_date: '2024-02-29', confirm: true })).status).toBe(200);
  const backup = (await (await client.get('/api/export')).json()) as { items: Array<Record<string, unknown>>; renewals: Array<Record<string, unknown>> };
  expect((await post(client, '/api/restore', { confirm: true, backup })).status).toBe(200);
  expect((await client.json('/api/items') as Array<{ suggested_next: string }>)[0].suggested_next).toBe('2024-03-31');
  const exported = (await (await client.get('/api/export')).json()) as typeof backup;
  expect(exported.renewals).toEqual(backup.renewals);
  for (const mutation of ['duplicate', 'anchor', 'history', 'currency']) {
    const bad = JSON.parse(JSON.stringify(backup));
    if (mutation === 'duplicate') bad.items.push(bad.items[0]);
    if (mutation === 'anchor') bad.items[0].anchor_day = false;
    if (mutation === 'history') bad.renewals[0].subscription_id = '0'.repeat(32);
    if (mutation === 'currency') bad.currency = 'USD';
    expect((await post(client, '/api/restore', { confirm: true, backup: bad })).status, mutation).toBe(400);
    expect(await (await client.get('/api/export')).json()).toEqual(backup);
  }
});

test('数据库写入失败时事务回滚且备份文件完好', async () => {
  await post(client, '/api/items', item());
  const before = await (await client.get('/api/export')).json();
  const file = path.join(dir, 'ledger.sqlite3');
  const conn = new Database(file);
  conn.exec("CREATE TRIGGER refuse_insert BEFORE INSERT ON subscriptions BEGIN SELECT RAISE(ABORT, 'injected failure'); END;");
  conn.close();
  const res = await post(client, '/api/restore', { confirm: true, backup: before });
  expect(res.status).toBe(500);
  expect(await (await client.get('/api/export')).json()).toEqual(before);
  const backups = fs.readdirSync(path.join(dir, 'backups')).filter((f) => f.endsWith('.sqlite3'));
  expect(backups).toHaveLength(1);
  const check = new Database(path.join(dir, 'backups', backups[0]), { readonly: true });
  expect((check.prepare('SELECT COUNT(*) AS n FROM subscriptions').get() as { n: number }).n).toBe(1);
  check.close();
});

test('续费确认：未确认/未来实际日期/倒退日期均拒绝；状态可来回切换', async () => {
  const res = await post(client, '/api/items', item());
  const ident = ((await res.json()) as { id: string }).id;
  for (const patch of [{ confirm: false }, { actual_date: '2100-01-01' }, { next_date: '2024-01-01' }]) {
    const data = { confirm: true, actual_date: '2024-01-31', next_date: '2024-02-29', ...patch };
    expect((await post(client, `/api/items/${ident}/renew`, data)).status).toBe(400);
  }
  for (const status of ['cancelling', 'cancelled', 'ended', 'active']) {
    expect((await post(client, `/api/items/${ident}`, item({ status }), 'put')).status).toBe(200);
    expect((await client.json('/api/items') as Array<{ status: string }>)[0].status).toBe(status);
  }
});

test('备份目录不可用时恢复失败且不改动数据', async () => {
  await post(client, '/api/items', item());
  const before = await (await client.get('/api/export')).json();
  // 用同名文件占位 backups 路径，使 mkdir 失败，模拟磁盘故障。
  fs.writeFileSync(path.join(dir, 'backups'), 'blocked');
  const res = await post(client, '/api/restore', { confirm: true, backup: before });
  expect(res.status).toBe(500);
  expect(await (await client.get('/api/export')).json()).toEqual(before);
});
