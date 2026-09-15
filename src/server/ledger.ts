/** 网页、Agent、定时任务共用的记账操作。事务覆盖余额、流水和请求去重。 */
import crypto from 'node:crypto';
import { db } from './db';
import { domain, validate, parseDate, parseAmount, parseBalance, parseBalanceCents, nowIsoInShanghai, todayInShanghai, DomainError, type SubscriptionRecord } from './domain';
import type { BalanceEntry } from '../lib/types';

export type Item = SubscriptionRecord & { id: string };
export type Source = 'web' | 'agent' | 'schedule';
export class HttpError extends DomainError {
  constructor(public status: number, message: string) { super(message); }
}
export const newId = () => crypto.randomBytes(16).toString('hex');
export function rows(): Item[] {
  return (db().prepare('SELECT id,payload FROM subscriptions').all() as Array<{ id: string; payload: string }>).map(r => ({ ...JSON.parse(r.payload), id: r.id }));
}
export function getRow(id: string): Item | null {
  const row = db().prepare('SELECT payload FROM subscriptions WHERE id=?').get(id) as { payload: string } | undefined;
  return row ? { ...JSON.parse(row.payload), id } : null;
}
export function requireItem(id: string): Item {
  const r = getRow(id);
  if (!r) throw new HttpError(404, '记录不存在');
  return r;
}
export function saveItem(r: Item): void {
  const { id, suggested_next: _next, ...payload } = r;
  db().prepare('UPDATE subscriptions SET payload=? WHERE id=?').run(JSON.stringify(payload), id);
}
export function entries(id?: string): BalanceEntry[] {
  const rows = (id ? db().prepare('SELECT payload FROM balance_entries WHERE subscription_id=? ORDER BY sequence').all(id)
    : db().prepare('SELECT payload FROM balance_entries ORDER BY sequence').all()) as Array<{ payload: string }>;
  return rows.map(r => JSON.parse(r.payload));
}
function addEntry(r: Item, patch: Pick<BalanceEntry, 'kind' | 'delta_cents' | 'effective_date' | 'source'> & Partial<BalanceEntry>): BalanceEntry {
  const balance = parseBalanceCents((r.balance_cents ?? 0) + patch.delta_cents);
  const entry: BalanceEntry = { id: newId(), subscription_id: r.id, recorded_at: nowIsoInShanghai(), period_date: null,
    reference_id: null, bill_amount_cents: null, estimated: false, notes: '', ...patch, balance_after_cents: balance };
  db().prepare('INSERT INTO balance_entries(id,subscription_id,kind,period_date,payload) VALUES (?,?,?,?,?)')
    .run(entry.id, r.id, entry.kind, entry.period_date, JSON.stringify(entry));
  r.balance_cents = balance;
  return entry;
}
export function settleItem(r: Item, today = todayInShanghai()): number {
  if (r.kind !== 'prepaid' || !['active', 'cancelling'].includes(r.status)) return 0;
  let count = 0;
  while (r.next_date <= today) {
    if (r.next_date <= r.balance_as_of!) throw new DomainError('扣减日期早于余额核对日期，请修改计划');
    const exists = db().prepare("SELECT id FROM balance_entries WHERE subscription_id=? AND kind='charge' AND period_date=?").get(r.id, r.next_date);
    if (!exists) {
      addEntry(r, { kind: 'charge', delta_cents: -r.amount_cents, effective_date: r.next_date, period_date: r.next_date,
        bill_amount_cents: r.amount_cents, estimated: r.cost_type === 'estimated', source: 'schedule' });
      count++;
    }
    r.next_date = domain.advance(r);
  }
  saveItem(r);
  return count;
}
export function settleAll(today = todayInShanghai()): { count: number; errors: string[] } {
  let count = 0;
  const errors: string[] = [];
  for (const item of rows().filter(r => r.kind === 'prepaid')) {
    try { count += db().transaction(() => settleItem(requireItem(item.id), today)).immediate(); }
    catch { errors.push(`${item.name}：自动扣减失败，请检查余额范围和扣减日期`); }
  }
  return { count, errors };
}

type Result = { data: unknown; status?: number };
type CommandOptions = { source: Source; key?: string; principal?: string };
export function command(action: string, id: string, data: Record<string, unknown>, opts: CommandOptions, work?: () => Result): Result {
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify([action, id, data])).digest('hex');
  const key = opts.key ? `${opts.principal ?? opts.source}:${opts.key}` : null;
  if (opts.key && !/^[A-Za-z0-9_-]{8,128}$/.test(opts.key)) throw new DomainError('请求标识须为 8–128 位字母、数字、下划线或连字符');
  return db().transaction(() => {
    if (key) {
      const previous = db().prepare('SELECT fingerprint,result FROM api_requests WHERE request_key=?').get(key) as { fingerprint: string; result: string } | undefined;
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new HttpError(409, '同一请求标识不能用于不同操作，请使用新的请求标识');
        return JSON.parse(previous.result) as Result;
      }
    }
    const result = work ? work() : apply(action, id, data, opts.source);
    if (key) db().prepare('INSERT INTO api_requests VALUES (?,?,?)').run(key, fingerprint, JSON.stringify(result));
    return result;
  }).immediate();
}

function apply(action: string, id: string, data: Record<string, unknown>, source: Source): Result {
  const conn = db();
  if (action === 'create') {
    const clean = validate(data);
    const r = { ...clean, id: newId() };
    conn.prepare('INSERT INTO subscriptions VALUES (?,?)').run(r.id, JSON.stringify(clean));
    if (r.kind === 'prepaid') {
      const initial = r.balance_cents!;
      r.balance_cents = 0;
      addEntry(r, { kind: 'opening', delta_cents: initial, effective_date: r.balance_as_of!, source });
      settleItem(r);
    }
    return { data: r, status: 201 };
  }
  const r = requireItem(id);
  if (action === 'delete') {
    if (data.confirm !== true) throw new DomainError('删除需要明确确认');
    for (const table of ['renewals', 'balance_entries', 'notifications']) conn.prepare(`DELETE FROM ${table} WHERE subscription_id=?`).run(id);
    conn.prepare('DELETE FROM subscriptions WHERE id=?').run(id);
    return { data: { ok: true } };
  }
  // 先按旧计划补齐已到期消费，随后编辑计划或调整余额，避免覆盖尚未入账的扣减。
  settleItem(r);
  if (action === 'edit') {
    const clean = validate(data, r);
    if (r.kind === 'prepaid') {
      const latest = conn.prepare("SELECT MAX(period_date) AS date FROM balance_entries WHERE subscription_id=? AND kind='charge'").get(id) as { date: string | null };
      if (latest.date && clean.next_date <= latest.date) throw new DomainError('下次扣减日期须晚于最后一个已扣减账期');
    }
    saveItem({ ...clean, id });
    return { data: { ok: true } };
  }
  if (r.kind !== 'prepaid') throw new DomainError('该操作仅适用于余额账户');
  const notes = data.notes ?? '';
  if (typeof notes !== 'string' || notes.length > 1000) throw new DomainError('流水备注不能超过 1000 字');
  const today = todayInShanghai();
  let entry: BalanceEntry;
  if (action === 'topup') {
    const amount = parseAmount(data.amount);
    if (amount <= 0) throw new DomainError('充值金额须大于零');
    entry = addEntry(r, { kind: 'topup', delta_cents: amount, effective_date: today, source, notes });
  } else if (action === 'reconcile') {
    const balance = parseBalance(data.balance);
    entry = addEntry(r, { kind: 'reconcile', delta_cents: balance - r.balance_cents!, effective_date: today, source, notes });
    r.balance_as_of = today;
    // 暂停账户也须将后续计划放在校正日之后，校正余额已包含之前的实际消费。
    while (r.next_date <= today) r.next_date = domain.advance(r);
  } else if (action === 'bill') {
    const history = entries(id);
    const index = history.findIndex(e => e.id === data.entry_id && e.kind === 'charge');
    if (index < 0) throw new DomainError('请选择已有的周期扣减流水');
    const charge = history[index];
    const amount = parseAmount(data.amount);
    const corrections = history.filter(e => e.reference_id === charge.id);
    const previous = corrections.at(-1)?.bill_amount_cents ?? charge.bill_amount_cents!;
    const checkpointAfter = history.slice(index + 1).some(e => e.kind === 'reconcile');
    entry = addEntry(r, { kind: 'bill_adjustment', delta_cents: checkpointAfter ? 0 : previous - amount,
      effective_date: today, reference_id: charge.id, bill_amount_cents: amount, source,
      notes: checkpointAfter ? `之后已核对余额，本次仅校正历史账单。${notes}` : notes });
  } else throw new HttpError(404, '操作不存在');
  saveItem(r);
  return { data: { ok: true, item: r, entry } };
}
