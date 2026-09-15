import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { command, entries, getRow, settleAll, type Item } from '@/server/ledger';
import { db, resetStateForTests } from '@/server/db';
import { createToken } from '@/server/agent-auth';
import { handleApi } from '@/server/api';
import { hashPassword } from '@/server/auth';
import { notificationStatus, reminders, saveSettings, sendTelegram, telegramChats, tick } from '@/server/notifications';
import { TestClient } from './helpers';

let dir: string;
const at = (date: string) => vi.setSystemTime(new Date(date + 'T04:00:00Z'));
const opts = { source: 'web' as const };
const input = (patch = {}) => ({ name: '话费', amount: '59.00', cycle: 'monthly', next_date: '2026-02-28', status: 'active', auto_renew: false, kind: 'prepaid', cost_type: 'estimated', balance: '120.00', balance_as_of: '2026-01-31', low_balance: '0', ...patch });
const create = (patch = {}) => command('create', '', input(patch), opts).data as Item;
const call = (token: string, method: string, path: string, body?: unknown, key = 'test-request-0001') => handleApi(new Request('http://test.local/api/v1' + path, { method, headers: { authorization: 'Bearer ' + token, 'Idempotency-Key': key, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }));
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-prepaid-'));
  process.env.LEDGER_DATA_DIR = dir;
  vi.useFakeTimers({ toFake: ['Date'] }); at('2026-01-31');
});
afterEach(() => { resetStateForTests(); vi.useRealTimers(); vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); delete process.env.LEDGER_DATA_DIR; delete process.env.LEDGER_TEST_PASSWORD_HASH; });

test('首次余额不补扣核对日之前消费，停机补齐后按月底锚点推进且可保留欠额', () => {
  expect(() => create({ next_date: '2026-01-31' })).toThrow(/核对|余额/);
  at('2026-01-30');
  const r = create({ balance: '179', balance_as_of: '2026-01-30', next_date: '2026-01-31' });
  expect(entries(r.id)).toHaveLength(1);
  at('2026-04-30');
  expect(settleAll()).toEqual({ count: 4, errors: [] });
  expect(getRow(r.id)).toMatchObject({ balance_cents: -5700, next_date: '2026-05-31' });
  expect(entries(r.id).filter(e => e.kind === 'charge').map(e => e.period_date)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
  expect(settleAll().count).toBe(0);
  resetStateForTests(); expect(settleAll().count).toBe(0);
});

test('充值、重复请求、余额校正和账单差额使用同一事务', () => {
  const r = create(); at('2026-02-28'); settleAll();
  const charge = entries(r.id)[1];
  const first = command('topup', r.id, { amount: '100' }, { ...opts, key: 'topup-000001' });
  expect(command('topup', r.id, { amount: '100' }, { ...opts, key: 'topup-000001' })).toEqual(first);
  expect(getRow(r.id)?.balance_cents).toBe(16100);
  expect(() => command('topup', r.id, { amount: '101' }, { ...opts, key: 'topup-000001' })).toThrow(/同一请求/);
  command('bill', r.id, { entry_id: charge.id, amount: '65' }, opts);
  expect(getRow(r.id)?.balance_cents).toBe(15500);
  command('bill', r.id, { entry_id: charge.id, amount: '62' }, opts);
  expect(getRow(r.id)?.balance_cents).toBe(15800);
  command('reconcile', r.id, { balance: '150' }, opts);
  command('bill', r.id, { entry_id: charge.id, amount: '70' }, opts);
  expect(getRow(r.id)?.balance_cents).toBe(15000);
  expect(entries(r.id).at(-1)?.delta_cents).toBe(0);
  expect(() => command('topup', r.id, { amount: '-5' }, opts)).toThrow();
  expect(getRow(r.id)?.balance_cents).toBe(15000);
});

test('校正可跨过暂停期间；暂停不扣费，编辑不能覆盖余额或已扣账期', () => {
  const r = create({ status: 'cancelled' }); at('2026-04-30');
  expect(settleAll().count).toBe(0);
  command('reconcile', r.id, { balance: '80' }, opts);
  expect(getRow(r.id)).toMatchObject({ balance_cents: 8000, next_date: '2026-05-28', balance_as_of: '2026-04-30' });
  command('edit', r.id, { ...getRow(r.id), status: 'active' }, opts);
  expect(settleAll().count).toBe(0);
  expect(() => command('edit', r.id, { ...getRow(r.id), balance: '10' }, opts)).toThrow(/充值|校正/);
  expect(() => command('edit', r.id, { ...getRow(r.id), next_date: '2026-04-30' }, opts)).toThrow();
});

test('半年度、自定义月数和闰年年度扣减复用日历规则', () => {
  at('2024-02-29');
  const r = create({ cycle: 'years', years: 1, balance_as_of: '2024-02-28', next_date: '2024-02-29', balance: '1000' });
  at('2028-02-29'); expect(settleAll().count).toBe(4);
  expect(getRow(r.id)?.next_date).toBe('2029-02-28');
  const two = create({ cycle: 'months', months: 2, balance_as_of: '2028-02-29', next_date: '2028-03-31' });
  const half = create({ cycle: 'semiannual', balance_as_of: '2028-02-29', next_date: '2028-03-31' });
  at('2028-05-31'); settleAll();
  expect(getRow(two.id)?.next_date).toBe('2028-07-31'); expect(getRow(half.id)?.next_date).toBe('2028-09-30');
});

test('余额越界使整个命令及去重结果回滚', () => {
  const r = create({ balance: '99999999.99' });
  expect(() => command('topup', r.id, { amount: '1' }, { ...opts, key: 'overflow-001' })).toThrow();
  expect(entries(r.id)).toHaveLength(1);
  expect(db().prepare('SELECT COUNT(*) n FROM api_requests').get()).toEqual({ n: 0 });
});

test('Agent Bearer 独立鉴权、最小权限、去重与撤销立即生效', async () => {
  const read = createToken({ name: '查询', scope: 'read' }); const write = createToken({ name: 'Hermes', scope: 'write' });
  expect((await call('', 'GET', '/items')).status).toBe(401);
  expect((await call(read.token, 'POST', '/items', input())).status).toBe(403);
  for (const p of ['/notifications', '/tokens', '/export', '/restore']) expect((await call(write.token, 'GET', p)).status).toBe(403);
  const result = await call(write.token, 'POST', '/items', input()); expect(result.status).toBe(201);
  const created = await result.json(); expect(await (await call(write.token, 'POST', '/items', input())).json()).toEqual(created);
  const top = await call(write.token, 'POST', `/items/${created.id}/topup`, { amount: '10' }, 'topup-agent-01'); expect(top.status).toBe(200);
  expect((await call(write.token, 'POST', `/items/${created.id}/topup`, { amount: '10' }, '')).status).toBe(400);
  expect(entries(created.id).at(-1)?.source).toBe('agent');
  expect((await call(read.token, 'GET', '/openapi.json')).status).toBe(200);
  expect(JSON.stringify(db().prepare('SELECT * FROM agent_tokens').all())).not.toContain(write.token);
  db().prepare('DELETE FROM agent_tokens WHERE id=?').run(write.id);
  expect((await call(write.token, 'GET', '/items')).status).toBe(401);
});

test('v2 备份还原全部流水且拒绝损坏余额；v1 仍可恢复且密钥不进入导出', async () => {
  process.env.LEDGER_TEST_PASSWORD_HASH = hashPassword('test-password-123');
  const client = new TestClient(); await client.login();
  const r = create(); at('2026-02-28'); settleAll();
  command('topup', r.id, { amount: '50' }, opts); command('bill', r.id, { entry_id: entries(r.id)[1].id, amount: '62' }, opts);
  command('reconcile', r.id, { balance: '105' }, opts); command('bill', r.id, { entry_id: entries(r.id)[1].id, amount: '70' }, opts);
  const token = createToken({ name: 'secret', scope: 'write' });
  const backup = await client.json('/api/export') as any;
  expect(backup.version).toBe(2); expect(JSON.stringify(backup)).not.toContain(token.token);
  const broken = structuredClone(backup); broken.balance_entries[1].balance_after_cents++;
  expect((await client.post('/api/restore', { confirm: true, backup: broken })).status).toBe(400);
  expect(getRow(r.id)?.balance_cents).toBe(10500);
  expect((await client.post('/api/restore', { confirm: true, backup })).status).toBe(200);
  expect((await client.json('/api/export') as any).balance_entries).toEqual(backup.balance_entries);
  expect((await call(token.token, 'GET', '/items')).status).toBe(200);
  const legacy = { format: 'subscription-ledger', version: 1, currency: 'CNY', items: [], renewals: [] };
  expect((await client.post('/api/restore', { confirm: true, backup: legacy })).status).toBe(200);
  expect(entries()).toEqual([]);
});

const bot = { enabled: true, token: '12345:abcdefghijklmnopqrstuvwxyz012345', chat_id: '123456', lead_days: 3, base_url: 'https://ledger.example' };
const delivered = () => Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
test('worker 无需 Hermes 或启用通知，也会扣减；TG 正常只发送一次且查询不消费提醒', async () => {
  const r = create({ balance: '110' }); at('2026-02-28');
  const fetcher = vi.fn(delivered);
  expect(await tick(fetcher)).toMatchObject({ charged: 1, sent: 0 }); expect(fetcher).not.toHaveBeenCalled();
  saveSettings(bot);
  const pending = reminders(); expect(pending[0].text).toContain('估算');
  expect(await tick(fetcher)).toMatchObject({ charged: 0, sent: 1 });
  expect(await tick(fetcher)).toMatchObject({ sent: 0 }); expect(fetcher).toHaveBeenCalledTimes(1);
  expect(reminders()).toEqual(pending); expect(getRow(r.id)?.balance_cents).toBe(5100);
  expect(JSON.stringify(notificationStatus())).not.toContain(bot.token);
  expect(fs.statSync(path.join(dir, 'notifications.json')).mode & 0o777).toBe(0o600);
});

test('失败通知退避重试且充值解决后取消旧通知，不泄漏 Token', async () => {
  const r = create({ balance: '10' }); saveSettings(bot);
  const fail = vi.fn(async () => { throw new Error('secret ' + bot.token); });
  expect(await tick(fail)).toMatchObject({ sent: 0, errors: 1 }); await tick(fail); expect(fail).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(notificationStatus())).not.toContain(bot.token);
  command('topup', r.id, { amount: '500' }, opts); vi.setSystemTime(Date.now() + 61000);
  const fetcher = vi.fn(delivered); await tick(fetcher); expect(fetcher).not.toHaveBeenCalled();
  expect(notificationStatus().recent).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'cancelled' })]));
});

test('到期前和当天各一次；429 遵守 retry_after；网络错误脱敏', async () => {
  command('create', '', { name: '订阅', amount: '20', cycle: 'monthly', next_date: '2026-02-03', status: 'active', auto_renew: false }, opts);
  saveSettings(bot); const fetcher = vi.fn(delivered);
  await tick(fetcher); await tick(fetcher); expect(fetcher).toHaveBeenCalledTimes(1);
  at('2026-02-03'); await tick(fetcher); expect(fetcher).toHaveBeenCalledTimes(2);
  at('2026-02-04'); await tick(fetcher); expect(fetcher).toHaveBeenCalledTimes(2);
  await expect(sendTelegram('x', bot, async () => new Response(JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 120 } }), { status: 429 }))).rejects.toMatchObject({ retryAfter: 120 });
  await expect(sendTelegram('x', bot, async () => { throw new Error(bot.token); })).rejects.toThrow('网络请求失败');
});

test('提醒的预测阈值边界、停用排除和同时执行的 worker 发送认领', async () => {
  const r = create({ next_date: '2026-02-03', balance: '118' }); saveSettings(bot);
  expect(reminders()).toEqual([]); // 正好足够两期，不提前催充。
  command('reconcile', r.id, { balance: '117.99' }, opts);
  expect(reminders()[0].title).toContain('下次扣减后');
  let complete!: () => void;
  const waiting = new Promise<void>(resolve => { complete = resolve; });
  const fetcher = vi.fn(async () => { await waiting; return new Response('{"ok":true}'); });
  const a = tick(fetcher); const b = tick(fetcher);
  complete(); await Promise.all([a, b]); expect(fetcher).toHaveBeenCalledTimes(1);
  command('edit', r.id, { ...getRow(r.id), status: 'cancelled' }, opts);
  expect(reminders()).toEqual([]);
});

test('实际账单不能引用另一账户的流水，失败不改变余额', () => {
  const a = create(); const b = create({ name: '电费' }); at('2026-02-28'); settleAll();
  expect(() => command('bill', b.id, { entry_id: entries(a.id)[1].id, amount: '20' }, opts)).toThrow(/已有/);
  expect(getRow(b.id)?.balance_cents).toBe(6100);
});

test('独立 Bot 私聊发现不消费更新、不回传 Token，排除群组', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: [
    { message: { chat: { id: 1, type: 'private', first_name: '我' } } },
    { message: { chat: { id: -2, type: 'group', first_name: '群' } } },
    { message: { chat: { id: 1, type: 'private', first_name: '我' } } },
  ] })));
  expect(await telegramChats(bot.token, fetcher)).toEqual([{ id: '1', label: '我' }]);
  const init = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1];
  expect(JSON.parse(init.body as string)).not.toHaveProperty('offset');
  await expect(telegramChats(bot.token, async () => { throw new Error(bot.token); })).rejects.toThrow('读取 Telegram 私聊失败');
});
