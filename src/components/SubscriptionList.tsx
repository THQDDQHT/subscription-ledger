'use client';

import { useState } from 'react';
import { Check, ChevronRight, Contrast, ListFilter, Plus, Search, X } from 'lucide-react';
import { useLedger } from './ledger-context';
import { DateText, MoneyText } from './bits';
import { cycleLabel, relativeDay } from '@/lib/format';
import { isActive, labels, recentGroup, selectGroups } from '@/lib/grouping';
import type { Subscription } from '@/lib/types';

function SkeletonRows({ count = 6 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="subscription skeleton" aria-hidden="true">
          <div className="row-title">
            <span className="bone bone--avatar" />
            <div className="row-name">
              <span className="bone bone--w60" />
              <span className="bone bone--w40" />
            </div>
          </div>
          <div className="row-amount">
            <span className="bone bone--w60" />
            <span className="bone bone--w40" />
          </div>
          <div className="row-date">
            <span className="bone bone--w60" />
            <span className="bone bone--w80" />
          </div>
          <div className="row-status">
            <span className="bone bone--chip" />
          </div>
        </div>
      ))}
    </>
  );
}

function Row({ r }: { r: Subscription }) {
  const { selectedId, view, today, showDetail, openRenew } = useLedger();
  const active = isActive(r);
  const rel = relativeDay(r.next_date, today);
  const group = recentGroup(r, today);
  return (
    <article
      className={`subscription${r.id === selectedId ? ' selected' : ''}`}
      onClick={(e) => {
        const target = e.target as HTMLElement;
        if (target.closest('button,a') || String(window.getSelection())) return;
        showDetail(r);
      }}
    >
      <button
        type="button"
        className="row-title"
        data-key={`${r.id}:detail`}
        aria-label={`查看 ${r.name} 的详情`}
        onClick={() => showDetail(r)}
      >
        <span className={`avatar avatar--${r.status}`} aria-hidden="true">
          {Array.from(r.name)[0] || '订'}
        </span>
        <span className="row-name">
          <span className="name-line">
            <span className="service-name">{r.name}</span>
            {r.auto_renew && <Contrast className="auto-mark" role="img" aria-label="已开启自动续费" />}
          </span>
          {!r.auto_renew && active && <small className="row-subline">手动续费</small>}
        </span>
      </button>
      <div className="row-amount">
        <strong>
          <MoneyText value={r.amount} />
        </strong>
        <small>{cycleLabel(r)}</small>
      </div>
      {active ? (
        <div className={`row-date${rel.cls ? ` ${rel.cls}` : ''}`}>
          <strong>{rel.text}</strong>
          <DateText iso={r.next_date} today={today} />
        </div>
      ) : (
        <div className="row-date idle">
          <strong>{r.end_date ? '服务截止' : '不再计入预算'}</strong>
          {r.end_date ? <DateText iso={r.end_date} today={today} /> : <small>—</small>}
        </div>
      )}
      <div className="row-status">
        {r.status !== 'active' && <span className={`chip chip--${r.status}`}>{labels[r.status]}</span>}
        <div className="row-actions">
          {view === 'recent' && (group === 'overdue' || group === 'week') ? (
            <button
              type="button"
              className="ghost compact"
              data-key={`${r.id}:renew`}
              aria-label={`记录 ${r.name} 的续费`}
              onClick={() => openRenew(r)}
            >
              <Check aria-hidden="true" />
              记录续费
            </button>
          ) : (
            <ChevronRight className="row-chevron" aria-hidden="true" />
          )}
        </div>
      </div>
    </article>
  );
}

export default function SubscriptionList({ filtersOpen, onToggleFilters }: { filtersOpen: boolean; onToggleFilters: () => void }) {
  const {
    items, today, view, filter, sort, keyword, collapsed, searching, loading, loadError,
    listScrollRef, setFilter, setSort, setKeyword, setGroupCollapsed, openEditor, navigate, load, reportError,
  } = useLedger();
  const [justOpened, setJustOpened] = useState('');

  const groups = selectGroups(items, { view, filter: filter as never, keyword, sort, today });
  const total = groups.reduce((n, g) => n + g.rows.length, 0);

  return (
    <section className="list-pane" aria-label="订阅列表">
      <div className="toolbar">
        <label className="search-field">
          <span className="sr-only">搜索名称或备注</span>
          <Search aria-hidden="true" />
          <input
            id="search"
            aria-label="搜索名称或备注"
            type="search"
            placeholder="搜索名称或备注"
            autoComplete="off"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          <kbd className="kbd-hint" aria-hidden="true">/</kbd>
          {keyword && (
            <button
              id="clear-search"
              type="button"
              className="icon-btn"
              aria-label="清空搜索"
              onClick={() => {
                setKeyword('');
                document.querySelector<HTMLInputElement>('#search')?.focus();
              }}
            >
              <X aria-hidden="true" />
            </button>
          )}
        </label>
        <button
          id="toggle-filters"
          type="button"
          className={`icon-btn mobile-only${filter !== 'all' || sort !== 'date' ? ' is-active' : ''}`}
          aria-label="筛选与排序"
          aria-expanded={filtersOpen}
          aria-controls="toolbar-filters"
          onClick={onToggleFilters}
        >
          <ListFilter aria-hidden="true" />
        </button>
        <span className="grow" />
        <div className="toolbar-filters" id="toolbar-filters">
          <label className="filter-field">
            <span className="sr-only">筛选状态</span>
            <select id="filter" value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="all">全部状态</option>
              <option value="active">使用中</option>
              <option value="cancelling">准备取消</option>
              <option value="cancelled">已取消续费</option>
              <option value="ended">已结束</option>
            </select>
          </label>
          <label className="sort-field">
            <span className="sr-only">组内排序</span>
            <select id="sort" value={sort} onChange={(e) => setSort(e.target.value as 'date' | 'name' | 'amount')}>
              <option value="date">续费日期 ↑</option>
              <option value="name">名称 A–Z</option>
              <option value="amount">每期金额 ↓</option>
            </select>
          </label>
        </div>
      </div>
      <div id="list-scroll" className="list-scroll" aria-busy={loading || undefined} ref={listScrollRef}>
        <div className="table-head">
          <span>
            订阅
            <span id="result-count" role="status" aria-live="polite">
              {loading ? '正在加载…' : searching ? `找到 ${total} 项` : `${total} 项`}
            </span>
          </span>
          <span>每期费用</span>
          <span>计划日期</span>
          <span>状态</span>
        </div>
        <div id="items">
          {loading ? (
            <SkeletonRows />
          ) : loadError ? (
            <div className="empty">
              <b>无法加载账本</b>
              <span>{loadError}</span>
              <button type="button" className="ghost" onClick={() => load().catch(reportError)}>
                重试
              </button>
            </div>
          ) : total === 0 ? (
            <div className="empty">
              <b>{items.length ? '这里暂时没有订阅' : '从第一份订阅开始'}</b>
              <span>
                {searching ? '试试其他名称或备注关键词。' : view === 'recent' ? '当前没有 30 天内待处理的计划。' : '点击新增订阅，记录费用与下次续费日期。'}
              </span>
              {!searching &&
                (items.length === 0 ? (
                  <button type="button" onClick={() => openEditor(null)}>
                    <Plus aria-hidden="true" />
                    新增订阅
                  </button>
                ) : view === 'recent' ? (
                  <a
                    href="#all"
                    onClick={(e) => {
                      e.preventDefault();
                      navigate('all');
                    }}
                  >
                    查看全部订阅
                  </a>
                ) : null)}
            </div>
          ) : (
            groups.map((group) => {
              const kind = group.key.split(':')[1];
              const open = searching || !collapsed.has(group.key);
              return (
                <details
                  key={group.key}
                  className={`subscription-group${kind === 'overdue' ? ' group--overdue' : kind === 'week' ? ' group--soon' : ''}${justOpened === group.key ? ' just-opened' : ''}`}
                  open={open}
                >
                  <summary
                    className="group-heading"
                    onClick={(e) => {
                      e.preventDefault();
                      if (searching) return;
                      setGroupCollapsed(group.key, !open);
                      if (!open) {
                        setJustOpened(group.key);
                        setTimeout(() => setJustOpened(''), 300);
                      }
                    }}
                  >
                    <span className="group-lead">
                      <span className="group-title">{group.title}</span>
                      <span className="count">{group.rows.length} 项</span>
                    </span>
                    {(view === 'recent' || kind === 'active' || kind === 'cancelling') && (
                      <span className="group-sum">
                        <MoneyText value={(group.rows.reduce((n, r) => n + r.amount_cents, 0) / 100).toFixed(2)} />
                      </span>
                    )}
                  </summary>
                  {group.rows.map((r) => (
                    <Row key={r.id} r={r} />
                  ))}
                </details>
              );
            })
          )}
        </div>
      </div>
    </section>
  );
}
