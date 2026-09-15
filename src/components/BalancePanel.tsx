'use client';

import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { api } from '@/lib/api';
import { money, recordedAt } from '@/lib/format';
import type { BalanceEntry, Subscription } from '@/lib/types';
import { useLedger } from './ledger-context';
import { useModalDialog } from './dialogs';

export type BalanceAction = { item: Subscription; action: 'topup' | 'reconcile' | 'bill'; entry?: BalanceEntry };
const titles = { topup: '记录充值', reconcile: '校正余额', bill: '补录实际账单' };
const entryLabels = { opening: '期初余额', charge: '周期扣减', topup: '充值', reconcile: '余额校正', bill_adjustment: '账单校正' };
export const cents = (value: number) => (value / 100).toFixed(2);

export function BalanceDialog({ state, onClose }: { state: BalanceAction | null; onClose: () => void }) {
  const { load, reportOk, reportError } = useLedger();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef({ body: '', key: '' });
  const { ref, onBackdrop } = useModalDialog(Boolean(state), onClose);
  useEffect(() => { request.current = { body: '', key: '' }; setError(''); }, [state]);
  const submit = async (form: HTMLFormElement) => {
    if (!state || busy) return;
    const data = Object.fromEntries(new FormData(form));
    if (state.entry) data.entry_id = state.entry.id;
    const body = JSON.stringify(data);
    if (request.current.body !== body) request.current = { body, key: crypto.randomUUID() };
    setBusy(true); setError('');
    try {
      await api(`/api/items/${state.item.id}/${state.action}`, 'POST', data, request.current.key);
      onClose();
      try { await load(); reportOk(`已${titles[state.action]}「${state.item.name}」`); }
      catch { reportError('记录已保存，列表刷新失败，请刷新页面查看。'); }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return <dialog id="balance-dialog" aria-labelledby="balance-title" ref={ref} onClick={busy ? undefined : onBackdrop} onCancel={e => { if (busy) e.preventDefault(); }}>
    {state && <form key={`${state.item.id}:${state.action}:${state.entry?.id}`} onSubmit={e => { e.preventDefault(); void submit(e.currentTarget); }}>
      <div className="dialog-head"><h2 id="balance-title">{titles[state.action]} · {state.item.name}</h2><button type="button" className="icon-btn" aria-label="关闭" disabled={busy} onClick={onClose}><X /></button></div>
      <div className="dialog-body">
        <p className="muted">当前账面余额 {money(cents(state.item.balance_cents ?? 0))}。仅记录账本变化。</p>
        {state.action === 'reconcile' ? <label>今天核对的实际余额<input name="balance" inputMode="decimal" required defaultValue={cents(state.item.balance_cents ?? 0)} /><small>支持负数。会先补齐到期消费，再把余额对齐到此数值。</small></label>
          : <label>{state.action === 'bill' ? `${state.entry?.period_date} 实际账单总额` : '充值金额'}<input name="amount" inputMode="decimal" required defaultValue={state.action === 'bill' ? cents(state.entry?.bill_amount_cents ?? 0) : ''} /><small>{state.action === 'bill' ? '填写总额，系统只调整差额；如果之后已核对余额，本次仅校正历史账单。' : '填写本次增加的金额。'}</small></label>}
        <label>备注<textarea name="notes" maxLength={1000} rows={3} /></label>
        {error && <p className="error" role="alert">{error}</p>}
      </div>
      <div className="dialog-foot"><button type="button" className="ghost" disabled={busy} onClick={onClose}>取消</button><span className="grow" /><button disabled={busy}>{busy ? '正在保存…' : '保存记录'}</button></div>
    </form>}
  </dialog>;
}

export function BalanceHistory({ item }: { item: Subscription }) {
  const { openBalance } = useLedger();
  const [rows, setRows] = useState<BalanceEntry[]>([]);
  const [error, setError] = useState('');
  const [limit, setLimit] = useState(30);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let live = true;
    setError('');
    api<BalanceEntry[]>(`/api/items/${item.id}/balance-entries`).then(r => { if (live) setRows(r); }).catch(e => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [item, retry]);
  return <section className="detail-history" aria-label="余额流水"><h3>余额流水</h3>
    {error && <p className="error" role="alert">{error}<button className="ghost compact" onClick={() => setRetry(n => n + 1)}>重试</button></p>}
    <ol className="history-list">{rows.slice(-limit).reverse().map(e => {
      const actual = rows.filter(r => r.reference_id === e.id).at(-1);
      return <li key={e.id} className="history-entry">
        <strong>{entryLabels[e.kind]}{e.estimated && !actual ? '（估算）' : ''} · {e.effective_date}</strong>
        <span className="history-amount">{e.delta_cents > 0 ? '+' : ''}{money(cents(e.delta_cents))}</span>
        <span className="history-sub">余额 {money(cents(e.balance_after_cents))}{e.kind === 'charge' && actual ? ` · 实际账单 ${money(cents(actual.bill_amount_cents!))}` : ''}</span>
        {e.notes && <span className="history-note">{e.notes}</span>}
        <span className="history-note">{recordedAt(e.recorded_at)} · {{ web: '网页', agent: 'Agent', schedule: '定时记账' }[e.source]}</span>
        {e.kind === 'charge' && <button className="ghost compact" onClick={() => openBalance({ item, action: 'bill', entry: { ...e, bill_amount_cents: actual?.bill_amount_cents ?? e.bill_amount_cents } })}>补录实际账单</button>}
      </li>;
    })}</ol>
    {rows.length > limit && <button className="ghost" onClick={() => setLimit(n => n + 30)}>加载更早流水</button>}
  </section>;
}
