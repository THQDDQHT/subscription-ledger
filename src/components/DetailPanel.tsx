'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, Pencil, Trash2, Undo2, X, ExternalLink } from 'lucide-react';
import { useLedger } from './ledger-context';
import { DateText, MoneyText } from './bits';
import { cycleLabel, friendlyDate, historySummary, money, recordedAt, relativeDay } from '@/lib/format';
import { isActive, labels } from '@/lib/grouping';
import type { Renewal, Subscription } from '@/lib/types';
import { api } from '@/lib/api';

function RenewalHistory({ r }: { r: Subscription }) {
  const { fetchHistory, confirm, clearReport, load, reportOk, reportError, setFocusKey, today } = useLedger();
  const [rows, setRows] = useState<Renewal[] | null>(null);
  const [error, setError] = useState('');

  const loadHistory = () => {
    setError('');
    fetchHistory(r.id)
      .then((data) => setRows(data))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  useEffect(() => {
    setRows(null);
    setError('');
    loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r.id, r.next_date]);

  const undo = async (h: Renewal) => {
    const paid = h.amount ? `，实付 ${money(h.amount)}` : '';
    const ok = await confirm({
      title: `撤销「${r.name}」最近一次续费？`,
      body: `计划日期将从 ${friendlyDate(h.next_date, today)} 退回 ${friendlyDate(h.previous_date, today)}；这条续费记录（${friendlyDate(h.actual_date, today)} 续费${paid}）会被删除。`,
      note: '不会更改订阅的每期金额、状态或日期锚点。',
      accept: '撤销续费',
    });
    if (!ok) return;
    clearReport();
    await api(`/api/items/${r.id}/renewals/${h.id}/undo`, 'POST', { confirm: true });
    setFocusKey(`${r.id}:detail`);
    try {
      await load();
    } catch (e) {
      reportError(`已撤销续费，但列表刷新失败：${e instanceof Error ? e.message : e}`);
      return;
    }
    reportOk(`已撤销「${r.name}」的续费 · 计划日期退回 ${h.previous_date}（${friendlyDate(h.previous_date, today)}）`);
  };

  return (
    <section className="detail-history" aria-label="续费历史">
      <h3>
        续费历史
        {rows && rows.length > 0 && <span className="history-summary">{historySummary(rows)}</span>}
      </h3>
      {error ? (
        <p className="history-status error">
          续费历史加载失败：{error}
          <button type="button" className="ghost compact" onClick={loadHistory}>
            重试
          </button>
        </p>
      ) : rows === null ? (
        <p className="history-status">正在加载续费历史…</p>
      ) : rows.length === 0 ? (
        <p className="history-status">尚无续费记录。记录续费后，实付金额与日期会留在这里。</p>
      ) : (
        <ol className="history-list">
          {rows.map((h, index) => (
            <li key={h.id} className="history-entry">
              <strong>
                实际续费 <DateText iso={h.actual_date} today={today} />
              </strong>
              {h.amount ? (
                <span className="history-amount">
                  <MoneyText value={h.amount} />
                </span>
              ) : (
                <span className="history-amount unknown">未记录金额</span>
              )}
              <span className="history-sub">
                原计划 {friendlyDate(h.previous_date, today)} → 下次 {friendlyDate(h.next_date, today)}
              </span>
              {h.recorded_at && <span className="history-note">记录于 {recordedAt(h.recorded_at)}</span>}
              {h.undoable ? (
                <button
                  type="button"
                  className="ghost compact"
                  data-key={`${r.id}:undo`}
                  aria-label={`撤销 ${r.name} 最近一次续费`}
                  onClick={() => void undo(h).catch(reportError)}
                >
                  <Undo2 aria-hidden="true" />
                  撤销这次续费
                </button>
              ) : (
                index === 0 && <span className="history-note">此后计划日期已被编辑，不能撤销；如需调整请直接编辑日期。</span>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export default function DetailPanel({ selected }: { selected: Subscription | null }) {
  const { today, closeDetail, openEditor, openRenew, confirm, load, reportOk, reportError, setFocusKey, detailError, detailRef } = useLedger();
  const bodyRef = useRef<HTMLDivElement>(null);
  const lastIdRef = useRef('');

  // 切换订阅时详情滚动回顶；同一订阅刷新时保持滚动位置
  useEffect(() => {
    if (selected && lastIdRef.current !== selected.id) {
      lastIdRef.current = selected.id;
      if (bodyRef.current) bodyRef.current.scrollTop = 0;
    }
  }, [selected]);

  const remove = async (r: Subscription) => {
    const ok = await confirm({
      title: `删除「${r.name}」？`,
      body: '这条订阅及其全部续费历史将被删除，无法撤销。',
      note: '如果只是停用，可改为「已取消续费」或「已结束」保留记录。',
      accept: '删除订阅',
    });
    if (!ok) return;
    await api(`/api/items/${r.id}`, 'DELETE', { confirm: true });
    closeDetail();
    await load();
    reportOk(`已删除「${r.name}」`);
  };

  return (
    <dialog
      id="detail"
      className="detail-drawer"
      aria-labelledby="detail-title"
      ref={detailRef}
      onCancel={(e) => {
        e.preventDefault();
        closeDetail();
      }}
      onClick={(e) => {
        // 点击遮罩关闭（原生 dialog 默认只在按 Esc 时关）
        if (e.target !== e.currentTarget) return;
        const box = e.currentTarget.getBoundingClientRect();
        if (e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom) closeDetail();
      }}
    >
      <div className="drawer-layout">
        <div className="dialog-head">
          <h2 id="detail-title">{selected?.name ?? '订阅详情'}</h2>
          <button type="button" className="icon-btn" id="close-detail" aria-label="关闭详情" onClick={closeDetail}>
            <X aria-hidden="true" />
          </button>
        </div>
        <div id="detail-body" className="dialog-body" ref={bodyRef}>
          {selected && (
            <>
              {detailError && (
                <p className="error" role="alert">
                  {detailError}
                </p>
              )}
              <span className={`chip chip--${selected.status}`}>{labels[selected.status]}</span>
              <p className="detail-amount">
                <MoneyText value={selected.amount} />
              </p>
              <p className="muted">{cycleLabel(selected)}</p>
              {isActive(selected) ? (
                (() => {
                  const rel = relativeDay(selected.next_date, today);
                  return (
                    <div className={`detail-plan${rel.cls ? ` ${rel.cls}` : ''}`}>
                      <span>当前待确认计划</span>
                      <strong>{rel.text}</strong>
                      <span className="detail-plan-date">
                        {selected.next_date} · {friendlyDate(selected.next_date, today)}
                      </span>
                    </div>
                  );
                })()
              ) : (
                <div className="detail-plan">
                  <span>原计划日期</span>
                  <strong>{selected.next_date}</strong>
                  <span className="detail-plan-date">{friendlyDate(selected.next_date, today)}</span>
                </div>
              )}
              <dl className="detail-facts">
                <dt>续费方式</dt>
                <dd>{selected.auto_renew ? '自动续费已开' : '手动续费'}</dd>
                <dt>计入预算</dt>
                <dd>{isActive(selected) ? '是' : '否'}</dd>
                <dt>服务可用截止日</dt>
                <dd>{selected.end_date ? `${selected.end_date} · ${friendlyDate(selected.end_date, today)}` : '未填写'}</dd>
              </dl>
              {selected.url && (
                <a className="detail-link" href={selected.url} target="_blank" rel="noopener noreferrer">
                  前往管理订阅
                  <ExternalLink aria-hidden="true" />
                </a>
              )}
              <h3>备注</h3>
              <p className="detail-notes">{selected.notes || '暂无备注'}</p>
              <RenewalHistory r={selected} />
              <button type="button" className="quiet danger-text" onClick={() => void remove(selected).catch(reportError)}>
                <Trash2 aria-hidden="true" />
                删除订阅
              </button>
            </>
          )}
        </div>
        <div id="detail-actions" className="dialog-foot">
          {selected && (
            <>
              <button type="button" className="ghost" onClick={() => openEditor(selected)}>
                <Pencil aria-hidden="true" />
                编辑订阅
              </button>
              {isActive(selected) && (
                <button type="button" onClick={() => openRenew(selected)}>
                  <Check aria-hidden="true" />
                  记录续费
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </dialog>
  );
}
