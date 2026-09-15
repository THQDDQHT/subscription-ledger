import type { BalanceEntry } from '../lib/types';
import { DomainError, parseBalanceCents, parseCents, parseDate, parseTimestamp, type SubscriptionRecord } from './domain';

/** 严格验证流水、引用和余额一致性，验证全部通过后才允许恢复。 */
export function validateBalanceEntries(raw: unknown, items: Map<string, SubscriptionRecord>): BalanceEntry[] {
  function fail(): never { throw new DomainError('余额流水无效、缺失或与账户余额不一致'); }
  if (!Array.isArray(raw) || raw.length > 50000) fail();
  const result: BalanceEntry[] = [];
  const ids = new Map<string, BalanceEntry>();
  const balances = new Map<string, number>();
  const checkpoints = new Map<string, string>();
  const periods = new Set<string>();
  const lastPeriod = new Map<string, string>();
  const checkpointVersions = new Map<string, number>();
  const bills = new Map<string, { amount: number; checkpoint: number }>();
  for (const data of raw as unknown[]) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) fail();
    const r = data as BalanceEntry;
    if (typeof r.id !== 'string' || !/^[a-f0-9]{32}$/.test(r.id) || ids.has(r.id)) fail();
    const item = items.get(r.subscription_id);
    if (!item || item.kind !== 'prepaid') fail();
    if (!['opening','charge','topup','reconcile','bill_adjustment'].includes(r.kind) || !['web','agent','schedule'].includes(r.source)) fail();
    if (typeof r.delta_cents !== 'number' || !Number.isSafeInteger(r.delta_cents) || Math.abs(r.delta_cents) > 2 * 99_999_999_99) fail();
    if (typeof r.estimated !== 'boolean' || typeof r.notes !== 'string' || r.notes.length > 1100) fail();
    const date = parseDate(r.effective_date);
    const recorded = parseTimestamp(r.recorded_at);
    const after = parseBalanceCents(r.balance_after_cents);
    const period = r.period_date === null ? null : parseDate(r.period_date);
    const bill = r.bill_amount_cents === null ? null : parseCents(r.bill_amount_cents);
    if (r.kind === 'opening') {
      if (balances.has(r.subscription_id) || period !== null || bill !== null || r.reference_id !== null) fail();
      checkpoints.set(r.subscription_id, date);
    } else if (!balances.has(r.subscription_id)) fail();
    if (r.kind === 'charge') {
      if (period !== date || bill === null || r.delta_cents !== -bill || r.reference_id !== null || date <= checkpoints.get(r.subscription_id)! || date >= item.next_date) fail();
      const key = `${r.subscription_id}:${period}`;
      if (periods.has(key) || (lastPeriod.get(r.subscription_id) ?? '') >= date) fail();
      periods.add(key);
      lastPeriod.set(r.subscription_id, date);
      bills.set(r.id, { amount: bill, checkpoint: checkpointVersions.get(r.subscription_id) ?? 0 });
    } else if (period !== null) fail();
    if (r.kind === 'bill_adjustment') {
      const ref = ids.get(r.reference_id ?? '');
      if (!ref || ref.kind !== 'charge' || ref.subscription_id !== r.subscription_id || bill === null) fail();
      const prior = bills.get(ref.id)!;
      const correctedLater = prior.checkpoint < (checkpointVersions.get(r.subscription_id) ?? 0);
      if (r.delta_cents !== (correctedLater ? 0 : prior.amount - bill)) fail();
      prior.amount = bill;
    } else if (r.reference_id !== null) fail();
    if (r.kind === 'topup' && (r.delta_cents <= 0 || bill !== null)) fail();
    if (r.kind === 'reconcile') {
      if (bill !== null || date < checkpoints.get(r.subscription_id)!) fail();
      checkpointVersions.set(r.subscription_id, (checkpointVersions.get(r.subscription_id) ?? 0) + 1);
      checkpoints.set(r.subscription_id, date);
    }
    const balance = (balances.get(r.subscription_id) ?? 0) + r.delta_cents;
    if (balance !== after) fail();
    balances.set(r.subscription_id, balance);
    const entry: BalanceEntry = { id: r.id, subscription_id: r.subscription_id, kind: r.kind, delta_cents: r.delta_cents,
      balance_after_cents: after, effective_date: date, recorded_at: recorded, source: r.source,
      period_date: period, reference_id: r.reference_id, bill_amount_cents: bill, estimated: r.estimated, notes: r.notes };
    ids.set(r.id, entry);
    result.push(entry);
  }
  for (const [id, item] of items) {
    if (item.kind === 'prepaid' && (balances.get(id) !== item.balance_cents || checkpoints.get(id) !== item.balance_as_of)) fail();
  }
  return result;
}
