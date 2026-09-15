'use client';

import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useLedger, type ConfirmOptions } from './ledger-context';
import { cycleLabel, friendlyDate, money } from '@/lib/format';
import { api } from '@/lib/api';
import type { Subscription } from '@/lib/types';
import { SelectField } from './SelectField';

export function useModalDialog(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const handle = () => onClose();
    d.addEventListener('close', handle);
    return () => d.removeEventListener('close', handle);
  }, [onClose]);
  const onBackdrop = (e: React.MouseEvent<HTMLDialogElement>) => {
    if (e.target !== e.currentTarget) return;
    const box = e.currentTarget.getBoundingClientRect();
    if (e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom) onClose();
  };
  return { ref, onBackdrop };
}

// ---------- 页面内确认：与其他弹窗同一套样式；关闭即视为取消。 ----------

interface ConfirmState extends ConfirmOptions {
  resolve: (value: boolean) => void;
}

export function ConfirmDialog({ state, onDone }: { state: ConfirmState | null; onDone: (value: boolean) => void }) {
  const [display, setDisplay] = useState<ConfirmState | null>(null);
  const { ref, onBackdrop } = useModalDialog(state !== null, () => onDone(false));
  useEffect(() => {
    if (state) {
      setDisplay(state);
      // 打开后焦点落到确认按钮
      const t = setTimeout(() => ref.current?.querySelector<HTMLButtonElement>('#confirm-accept')?.focus(), 0);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);
  return (
    <dialog id="confirm-dialog" aria-labelledby="confirm-title" ref={ref} onClick={onBackdrop}>
      {display && (
        <>
          <div className="dialog-head">
            <h2 id="confirm-title">{display.title}</h2>
            <button type="button" className="icon-btn" aria-label="关闭" onClick={() => onDone(false)}>
              <X aria-hidden="true" />
            </button>
          </div>
          <div className="dialog-body">
            <p id="confirm-body">{display.body}</p>
            <p id="confirm-note" className="muted">{display.note ?? ''}</p>
          </div>
          <div className="dialog-foot">
            <button type="button" className="ghost" onClick={() => onDone(false)}>
              取消
            </button>
            <span className="grow" />
            <button type="button" id="confirm-accept" className={display.danger === false ? '' : 'danger'} onClick={() => onDone(true)}>
              {display.accept ?? '确定'}
            </button>
          </div>
        </>
      )}
    </dialog>
  );
}

// ---------- 新增 / 编辑订阅 ----------

function useSubmitGuard() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    fn()
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  return { busy, error, run };
}

export function EditorDialog({ editing, onClose }: { editing: Subscription | null | undefined; onClose: () => void }) {
  const open = editing !== undefined;
  const { today, load, reportOk, reportError, clearReport, setFocusKey } = useLedger();
  const { ref, onBackdrop } = useModalDialog(open, onClose);
  const { busy, error, run } = useSubmitGuard();
  const [cycle, setCycle] = useState('monthly');
  const [kind, setKind] = useState('subscription');
  const customCycle = cycle === 'days' || cycle === 'months' || cycle === 'years' ? cycle : null;
  const customLabel = cycle === 'months' ? '月数' : cycle === 'years' ? '年数' : '天数';
  const customMax = cycle === 'months' ? 1200 : cycle === 'years' ? 100 : 36500;
  const [extraOpen, setExtraOpen] = useState(false);
  const [preview, setPreview] = useState('填写费用与日期，建立你的续费计划。');

  // 打开时初始化表单态（对应原版 f.reset() + 回填）
  useEffect(() => {
    if (!open) return;
    setCycle(editing?.cycle ?? 'monthly');
    setKind(editing?.kind ?? 'subscription');
    setExtraOpen(Boolean(editing && (editing.notes || editing.url || editing.end_date)));
    ref.current?.querySelector<HTMLInputElement>('input[name="name"]')?.focus({ preventScroll: true });
  }, [open, editing]);

  const updatePreview = (form: HTMLFormElement) => {
    const f = new FormData(form);
    const amount = String(f.get('amount') ?? '');
    const next = String(f.get('next_date') ?? '');
    const c = String(f.get('cycle') ?? 'monthly');
    const days = String(f.get('days') ?? '');
    const months = String(f.get('months') ?? '');
    const years = String(f.get('years') ?? '');
    setPreview(
      amount && next
        ? `${cycleLabel({ cycle: c, days: days || '…', months: months || '…', years: years || '…' })} · 每期 ${money(amount)} · 下次 ${next}（${friendlyDate(next, today)}）`
        : '填写费用与日期，建立你的续费计划。',
    );
  };

  // 等周期字段挂载或编辑值回填后再刷新预览。
  useEffect(() => {
    const form = ref.current?.querySelector('form');
    if (open && form) updatePreview(form);
  }, [cycle, editing, open, today]);

  const submit = (form: HTMLFormElement) => {
    run(async () => {
      const f = new FormData(form);
      const record: Record<string, unknown> = {};
      for (const key of ['name', 'amount', 'cycle', 'next_date', 'status', 'url', 'notes']) record[key] = String(f.get(key) ?? '');
      record.days = record.cycle === 'days' ? Number(f.get('days')) : null;
      if (record.cycle === 'months') record.months = Number(f.get('months'));
      if (record.cycle === 'years') record.years = Number(f.get('years'));
      record.end_date = String(f.get('end_date') ?? '') || null;
      record.auto_renew = f.get('auto_renew') === 'on';
      record.kind = kind;
      if (kind === 'prepaid') {
        record.auto_renew = false;
        record.cost_type = String(f.get('cost_type'));
        record.low_balance = String(f.get('low_balance') || '0');
        if (!editing) {
          record.balance = String(f.get('balance') ?? '');
          record.balance_as_of = String(f.get('balance_as_of') ?? '');
        }
      }
      clearReport();
      if (editing) await api(`/api/items/${editing.id}`, 'PUT', record);
      else await api('/api/items', 'POST', record);
      onClose();
      if (editing) setFocusKey(`${editing.id}:detail`);
      try {
        await load();
      } catch (e) {
        reportError(`已保存，但列表刷新失败：${e instanceof Error ? e.message : e}`);
        return;
      }
      reportOk(editing ? `已保存「${record.name}」` : `已新增「${record.name}」`);
    });
  };

  return (
    <dialog id="editor" aria-labelledby="editor-title" ref={ref} onClick={onBackdrop}>
      {open && (
        <form
          id="item-form"
          key={editing?.id ?? 'new'}
          onSubmit={(e) => {
            e.preventDefault();
            submit(e.currentTarget);
          }}
          onInput={(e) => updatePreview(e.currentTarget)}
          onChange={(e) => updatePreview(e.currentTarget)}
          onInvalid={(e) => {
            if ((e.target as HTMLElement).closest('#extra-fields')) setExtraOpen(true);
          }}
        >
          <div className="dialog-head">
            <h2 id="editor-title">{editing ? '编辑记录' : '新增记录'}</h2>
            <button type="button" className="icon-btn" aria-label="关闭" onClick={onClose}>
              <X aria-hidden="true" />
            </button>
          </div>
          <div className="dialog-body">
            <label>
              记录类型
              <SelectField label="记录类型" value={kind} disabled={Boolean(editing)} options={[
                { value: 'subscription', label: '订阅', description: '按期续费，如会员、软件订阅' },
                { value: 'prepaid', label: '余额账户', description: '先充值再扣减，如话费、水电' },
              ]} onValueChange={value => {
                setKind(value);
                const input = ref.current?.querySelector<HTMLInputElement>('[name="next_date"]');
                if (value === 'prepaid' && input && input.value <= today) {
                  const date = new Date(today + 'T00:00:00Z');
                  date.setUTCDate(date.getUTCDate() + 1);
                  input.value = date.toISOString().slice(0, 10);
                }
              }} />
            </label>
            <label>
              {kind === 'prepaid' ? '账户名称' : '订阅名称'}
              <input name="name" required maxLength={120} autoComplete="off" placeholder="例如 Netflix 高级会员" defaultValue={editing?.name ?? ''} />
            </label>
            <div className="columns">
              <label>
                每期金额（人民币元）
                <input name="amount" inputMode="decimal" type="text" pattern="(0|[1-9][0-9]{0,7})(\.[0-9]{1,2})?" placeholder="例如 25.00" required defaultValue={editing?.amount ?? ''} />
              </label>
              <label>
                计费周期
                <SelectField name="cycle" label="计费周期" value={cycle} onValueChange={setCycle} options={[
                  { value: 'monthly', label: '月付' },
                  { value: 'quarterly', label: '季付', description: '每 3 个日历月' },
                  { value: 'semiannual', label: '半年付', description: '每 6 个日历月' },
                  { value: 'yearly', label: '年付' },
                  { value: 'days', label: '自定义天数' },
                  { value: 'months', label: '自定义月数' },
                  { value: 'years', label: '自定义年数' },
                ]} />
              </label>
            </div>
            <p className="field-note">金额填写所选周期的总费用，例如年付填写全年金额。</p>
            {kind === 'prepaid' && (
              <>
                <label>费用类型<SelectField name="cost_type" label="费用类型" defaultValue={editing?.cost_type ?? 'fixed'} options={[
                  { value: 'fixed', label: '固定费用' },
                  { value: 'estimated', label: '估算费用', description: '之后可补录实际账单' },
                ]} /></label>
                {!editing && <div className="columns">
                  <label>当前余额（元）<input name="balance" required inputMode="decimal" pattern="-?(0|[1-9][0-9]{0,7})(\.[0-9]{1,2})?" placeholder="例如 120.00" /></label>
                  <label>余额核对日期<input name="balance_as_of" required type="date" min="1900-01-01" max={today} defaultValue={today} /></label>
                </div>}
                <label>余额提醒阈值（元）<input name="low_balance" inputMode="decimal" required pattern="(0|[1-9][0-9]{0,7})(\.[0-9]{1,2})?" defaultValue={((editing?.low_balance_cents ?? 0) / 100).toFixed(2)} /></label>
                <p className="field-note">低于下一期费用或此阈值时提醒。账面余额按计划扣减，实际余额可随时校正。</p>
                {editing && <p className="field-note">当前余额请通过详情中的“充值”或“校正余额”调整。</p>}
              </>
            )}
            {customCycle && (
              <div key={customCycle}>
                <label>
                  每周期{customLabel}
                  <input name={customCycle} type="number" inputMode="numeric" min={1} max={customMax} step={1} required defaultValue={editing?.[customCycle] ?? ''} aria-describedby="cycle-hint" />
                </label>
                <p id="cycle-hint" className="field-note">
                  {customCycle === 'days' ? '按固定天数递推。' : customCycle === 'months' ? '按日历月递推，例如填 2 表示每 2 个月续费。' : '按日历年递推，例如填 2 表示每 2 年续费。'}
                  {customCycle !== 'days' && '目标月份没有对应日期时，取当月最后一天。'}
                </p>
              </div>
            )}
            <label>
              {kind === 'prepaid' ? '下次自动扣减日期' : '下次扣款 / 续费日期'}
              <input name="next_date" type="date" min="1900-01-01" max="2100-12-31" required defaultValue={editing?.next_date ?? today} />
            </label>
            <p className="field-note">修改日期或周期后，后续续费将按新计划计算。</p>
            {kind !== 'prepaid' && <label className="check">
              <input name="auto_renew" type="checkbox" defaultChecked={editing?.auto_renew ?? false} />
              已在订阅平台开启自动续费（仅记录）
            </label>}
            <label>
              状态
              <SelectField name="status" label="状态" defaultValue={editing?.status ?? 'active'} options={[
                { value: 'active', label: '使用中' },
                { value: 'cancelling', label: '准备取消' },
                { value: 'cancelled', label: kind === 'prepaid' ? '暂停自动扣减' : '已取消续费' },
                { value: 'ended', label: '已结束' },
              ]} />
            </label>
            <details
              id="extra-fields"
              className="extra-fields"
              open={extraOpen}
              onToggle={(e) => setExtraOpen(e.currentTarget.open)}
            >
              <summary>
                补充信息 <span className="muted">截止日、管理链接、备注</span>
              </summary>
              <label>
                服务可用截止日（可选）
                <input name="end_date" type="date" min="1900-01-01" max="2100-12-31" defaultValue={editing?.end_date ?? ''} />
              </label>
              <label>
                管理链接（可选，仅 http/https）
                <input name="url" type="url" maxLength={2000} placeholder="https://..." defaultValue={editing?.url ?? ''} />
              </label>
              <label>
                备注（不要填写密码或 API Key）
                <textarea name="notes" rows={3} maxLength={5000} defaultValue={editing?.notes ?? ''} />
              </label>
            </details>
            <p id="plan-preview" className="plan-preview">{preview}</p>
            <p id="edit-error" className="error" role="alert">{error}</p>
          </div>
          <div className="dialog-foot">
            <button type="button" className="ghost" onClick={onClose}>
              取消
            </button>
            <span className="grow" />
            <button type="submit" disabled={busy}>
              {busy ? '保存中…' : '保存'}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}

// ---------- 记录续费 ----------

export function RenewDialog({ renewing, onClose }: { renewing: Subscription | null; onClose: () => void }) {
  const open = renewing !== null;
  const { today, items, load, reportOk, reportError, clearReport, setFocusKey } = useLedger();
  const { ref, onBackdrop } = useModalDialog(open, onClose);
  const { busy, error, run } = useSubmitGuard();

  const submit = (form: HTMLFormElement) => {
    if (!renewing) return;
    run(async () => {
      const f = new FormData(form);
      const amount = String(f.get('amount') ?? '');
      const next = String(f.get('next_date') ?? '');
      clearReport();
      await api(`/api/items/${renewing.id}/renew`, 'POST', {
        actual_date: String(f.get('actual_date') ?? ''),
        amount,
        next_date: next,
        confirm: f.get('confirm') === 'on',
      });
      onClose();
      setFocusKey(`${renewing.id}:renew`);
      try {
        await load();
      } catch (e) {
        reportError(`已记录续费，但列表刷新失败：${e instanceof Error ? e.message : e}`);
        return;
      }
      const name = items.find((x) => x.id === renewing.id)?.name ?? renewing.name;
      reportOk(`已续费「${name}」· 实付 ${money(amount)} · 下次 ${next}（${friendlyDate(next, today)}）`);
    });
  };

  return (
    <dialog id="renew-dialog" aria-labelledby="renew-title" ref={ref} onClick={onBackdrop}>
      {renewing && (
        <form
          id="renew-form"
          key={renewing.id}
          onSubmit={(e) => {
            e.preventDefault();
            submit(e.currentTarget);
          }}
        >
          <div className="dialog-head">
            <h2 id="renew-title">记录续费</h2>
            <button type="button" className="icon-btn" aria-label="关闭" onClick={onClose}>
              <X aria-hidden="true" />
            </button>
          </div>
          <div className="dialog-body">
            <p id="renew-name">{renewing.name}</p>
            <p className="field-note" id="renew-diff">
              当前计划日期 {renewing.next_date}（{friendlyDate(renewing.next_date, today)}）· 每期 {money(renewing.amount)}（{cycleLabel(renewing)}）
            </p>
            <p>仅在你确实完成续费后确认；默认下次日期按原计划递推，而非实际付款日。</p>
            <div className="columns">
              <label>
                实际续费日期
                <input type="date" name="actual_date" required min="1900-01-01" max={today || '2100-12-31'} defaultValue={today} />
              </label>
              <label>
                实际支付金额（人民币元）
                <input name="amount" inputMode="decimal" type="text" pattern="(0|[1-9][0-9]{0,7})(\.[0-9]{1,2})?" required defaultValue={renewing.amount} />
              </label>
            </div>
            <p className="field-note">实付金额只写入这次续费历史；涨价请另行编辑订阅的每期金额。</p>
            <label>
              下一次扣款 / 续费日期
              <input type="date" name="next_date" required min="1900-01-01" max="2100-12-31" defaultValue={renewing.suggested_next ?? ''} />
            </label>
            <label className="check">
              <input type="checkbox" name="confirm" required />
              我已核对并完成本次续费
            </label>
            <p id="renew-error" className="error" role="alert">{error}</p>
          </div>
          <div className="dialog-foot">
            <button type="button" className="ghost" onClick={onClose}>
              取消
            </button>
            <span className="grow" />
            <button type="submit" disabled={busy}>
              {busy ? '保存中…' : '确认保存'}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
