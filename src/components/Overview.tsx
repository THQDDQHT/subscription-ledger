'use client';

import { useLedger } from './ledger-context';
import { friendlyDate, daysUntil } from '@/lib/format';
import { isActive } from '@/lib/grouping';
import { MoneyText } from './bits';

export default function Overview() {
  const { stats, items, today, loading } = useLedger();
  const overdueCount = today ? items.filter((r) => isActive(r) && daysUntil(r.next_date, today) < 0).length : 0;
  return (
    <section id="overview" className={`overview${loading ? ' is-loading' : ''}`} aria-label="统计">
      <div className="metrics">
        <article>
          <span>未来 30 天预计续费</span>
          <strong id="forecast">{stats ? <MoneyText value={stats.forecast_30} /> : '—'}</strong>
          <small>按计划估算，非已扣款</small>
        </article>
        <article className={overdueCount > 0 ? 'has-overdue' : ''}>
          <span>逾期未确认</span>
          <strong id="overdue-count" className={overdueCount === 0 ? 'is-zero' : ''}>
            {stats ? (overdueCount ? `${overdueCount} 项` : '—') : '—'}
          </strong>
          <small>确认是否已续费，或更新计划</small>
        </article>
        <article>
          <span>月度等效预算</span>
          <strong id="budget">{stats ? <MoneyText value={stats.monthly_budget} /> : '—'}</strong>
          <small>周期折算，非实际账单</small>
        </article>
      </div>
      <div className="overview-note">
        <p id="window-note">{today ? `今天 ${today} · ${friendlyDate(today, today)} · 中国标准时间` : ''}</p>
        <details className="calculation">
          <summary>统计口径</summary>
          <p>使用中与准备取消计入预算。未来 30 天包含今天，不包含第 30 天；同一订阅可能有多次预计续费。近期处理仅显示每个订阅当前待确认的计划，分组小计为组内各订阅当前计划的每期金额之和。</p>
        </details>
      </div>
    </section>
  );
}
